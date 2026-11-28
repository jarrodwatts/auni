import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { listed, type AppSetting } from "@auni/shared";
import type { App, WalletAddresses } from "./apps/contract.ts";
import { appById, apps, hasSwitch, offered, walletApp } from "./apps/registry.ts";
import { db } from "./db/client.ts";
import { actions } from "./db/schema.ts";
import { envFile } from "./data-dir.ts";
import { noAddressOn, reachOf } from "./money/wallets.ts";
import { privateFields } from "./private-fields.ts";
import { setBy, settingField } from "./settings.ts";

// Auni offering an app at the moment it would help. A card can turn an app the owner switched
// off back on (connect_app), and a key it lacks is asked for by its private field (request_secret,
// which takes it in settings.ts's field for the app). Neither touches a setting only the owner's
// settings file changes, since those change whom Auni trusts. Core gives the agent the facts
// (which apps it could offer, and when the owner last said no) and the tools
// (agent/connect-tool.ts, agent/secret-tool.ts); when to offer is the agent's judgment. The card
// applies in asks.ts, which every money move loads: so this file reads settings and the registry,
// and never the portfolio.

/** Whether an app's settings matter now: a wallet app the owner doesn't use needs nothing. */
export function inUse({ about, wallet }: App): boolean {
  return !wallet || walletApp().about.id === about.id;
}

/** Each setting an app can't work without that is unset, by the name its app reads it by. */
export function unsetSettings(app: App): readonly (AppSetting & { readonly key: string })[] {
  if (!inUse(app)) return [];
  return Object.entries(app.about.settings ?? {}).flatMap(([key, declared]) =>
    declared.required && !setBy(declared.env) ? [{ key, ...declared }] : [],
  );
}

/** What it would take to connect an app, as it stands now. */
type Connecting =
  /**
   * It can be offered: turned back on by a card (`turnsOn`), and each of these keys asked for in
   * the app's private field.
   */
  | { readonly kind: "card"; readonly turnsOn: boolean; readonly keys: readonly string[] }
  /** Nothing is missing that a card could give. */
  | { readonly kind: "nothing" }
  /**
   * No card can connect it, said in the owner's words: it needs a setting only the owner's
   * settings file changes, or what it does is on a network the wallet has no address on.
   */
  | { readonly kind: "no-card"; readonly why: string };

/**
 * What the wallet lacks for `app` to be of any use, as its sheet names it: a Solana route trades
 * only on Solana, so a wallet brought with its EVM key alone needs a Solana address first. Null
 * when it lacks nothing, or there is no wallet yet, or it couldn't be read.
 */
export function walletLacks(app: App, wallet: WalletAddresses | null): string | null {
  return app.solana && !reachOf(wallet).solana ? "a Solana address" : null;
}

/**
 * What it would take to connect `app` now, for a `wallet` with these addresses (null where they
 * couldn't be read, which changes nothing). What the wallet lacks for it (walletLacks) no card
 * gives: the owner adds a Solana address in Settings first.
 */
export function connecting(app: App, wallet: WalletAddresses | null): Connecting {
  const unset = unsetSettings(app);
  const byHand = unset.filter(({ kind }) => kind === "file");
  if (byHand.length > 0)
    return {
      kind: "no-card",
      why: `${app.about.name} needs ${listed(byHand.map(({ label }) => label))}, which no card can set: it changes whom Auni trusts, so the owner sets ${listed(byHand.map(({ env }) => env))} in ${envFile()} and starts Auni again.`,
    };
  if (walletLacks(app, wallet))
    return {
      kind: "no-card",
      why: `${app.about.name} trades on Solana, so it would add nothing yet. ${noAddressOn("Solana")}`,
    };
  const off = hasSwitch(app) && !offered().includes(app);
  if (!off && unset.length === 0) return { kind: "nothing" };
  return { kind: "card", turnsOn: off, keys: unset.map(({ label }) => label) };
}

/**
 * What a card turning `app` back on is called, and its button: "Turn <app> on", or "Turn on" where
 * that is too long for a phone's button.
 */
export function offerNamed({ about }: App): { readonly title: string; readonly button: string } {
  const title = `Turn ${about.name} on`;
  return { title, button: title.length <= 18 ? title : "Turn on" };
}

/** What allowing a card that turns `app` back on does, as the card says it and core then does it. */
export function connects({ about }: App): string {
  return `Auni can use ${about.name} again, with its tools and what it knows of it. You can turn it off again under Apps.`;
}

/**
 * The system prompt's paragraph on apps a card could connect for a `wallet` with these
 * addresses, one line each; null when there is none. It changes only when a setting is saved or
 * the wallet gains an address, as the rest of the system prompt does.
 */
export function appsToOffer(wallet: WalletAddresses | null): string | null {
  const lines = apps().flatMap((app) => {
    const state = connecting(app, wallet);
    if (state.kind !== "card") return [];
    const missing = [
      ...(state.turnsOn ? ["the owner turned it off, which connect_app turns back on"] : []),
      ...(state.keys.length > 0
        ? [
            `it needs its ${listed(state.keys)}, which request_secret asks for in the field ${settingField(app.about.id)}`,
          ]
        : []),
    ];
    const does = app.about.does ? `: ${app.about.does}` : "";
    return [`- ${app.about.id} (${app.about.name}${does}). Not connected: ${listed(missing)}.`];
  });
  if (lines.length === 0) return null;
  return `# Apps you could offer

Everything Auni does goes through an app, and these aren't connected, so you have none of their tools or know-how now:
${lines.join("\n")}

When what the owner asks is the work of one they turned off, say first that it is off and offer to turn it back on with connect_app; don't look for a way round it first, since they may have turned it off on purpose. When one that needs a key would have helped, do the job as well as you can without it first, then ask for its key with request_secret, saying in one sentence what it would add for them. When to offer is your call: at the moment it would have helped, one app at a time, never as a list of what's missing, and not again soon after they said no (the context before each message says when they last declined one).`;
}

/**
 * When the owner last declined each card that offered an app or asked for a secret, while what it
 * offered still isn't there, for the turn's context: the agent judges from the date whether to
 * offer it again.
 */
export async function declinedOffers(
  timeZone: string,
  wallet: WalletAddresses | null,
): Promise<string | null> {
  const asked = sql<string>`coalesce(${actions.input}->>'field', ${actions.input}->>'app')`;
  const declined = await db
    .selectDistinctOn([actions.tool, asked], {
      tool: actions.tool,
      asked,
      summary: actions.summary,
      at: actions.updatedAt,
    })
    .from(actions)
    .where(
      and(
        inArray(actions.tool, ["connect_app", "request_secret"]),
        eq(actions.status, "cancelled"),
      ),
    )
    .orderBy(actions.tool, asked, desc(actions.updatedAt), desc(actions.seq));
  const fields = await privateFields();
  const lines = declined.flatMap(({ tool, asked: id, summary, at }) => {
    const day = at.toLocaleDateString("en-US", { timeZone, dateStyle: "long" });
    if (tool === "request_secret") {
      const field = fields.find((each) => each.id === id);
      if (!field || field.inputs.every(({ set }) => set)) return [];
      return [`On ${day} the owner declined your card asking for their ${summary}.`];
    }
    const app = appById(id);
    const state = app && connecting(app, wallet);
    if (!app || state?.kind !== "card" || !state.turnsOn) return [];
    return [`On ${day} the owner declined your card to turn ${app.about.name} on.`];
  });
  return lines.length > 0 ? lines.join("\n") : null;
}
