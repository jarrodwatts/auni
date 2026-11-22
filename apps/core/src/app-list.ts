import type { AppJob, AppWire, AppsWire } from "@auni/shared";
import type { Address } from "viem";

import { brainRows, pickBrain, whichBrainSays, type BrainRow } from "./agent/brain.ts";
import { appTroublesNow, troubleWords } from "./app-troubles.ts";
import type { App } from "./apps/contract.ts";
import { accountOwning, apps, closedHere, hasSwitch, offered } from "./apps/registry.ts";
import { theOwner } from "./auth/owner.ts";
import { channelStates } from "./channels/home.ts";
import { inUse, unsetSettings, walletLacks } from "./connect.ts";
import { settingsFile } from "./data-dir.ts";
import { holdingFaces } from "./money/holdings.ts";
import {
  keptOutsideWallet,
  portfolioNow,
  type Holding,
  type Portfolio,
} from "./money/portfolio.ts";
import { sumUsd, usdToCents } from "./money/usd.ts";
import { walletAddresses } from "./money/wallets.ts";
import { savedUntried, setBy, settingField, settingFields } from "./settings.ts";

// The apps in this Auni as the owner sees them (the Apps list and each app's sheet, `GET /apps`),
// and as the agent is told of them when one would help (connect.ts). It reads what stands now and
// changes nothing: a setting is saved by its private field, the switch by `PATCH /apps/:id`.

/** A setting's label as a sentence names it: "an API key", "a bot token". */
function withArticle(label: string): string {
  return `${/^[aeiou]/iu.test(label) ? "an" : "a"} ${label}`;
}

/** The jobs an app does for Auni itself, by the parts it has. */
function jobsOf(app: App): AppJob[] {
  const does: Record<AppJob, unknown> = {
    thinks: app.brain,
    keys: app.wallet,
    trades: app.swaps ?? app.solana,
    moves: app.bridge ?? app.payIn,
    prices: app.tokens,
    watches: app.watches,
  };
  return (Object.keys(does) as AppJob[]).filter((job) => does[job]);
}

/** "3:40 PM" in the owner's time zone, with the day when it isn't today. */
function clock(at: Date, timeZone: string): string {
  const day = (date: Date) => date.toLocaleDateString("en-US", { timeZone });
  return at.toLocaleString("en-US", {
    timeZone,
    ...(day(at) === day(new Date()) ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Why a brain can't think yet, as its tile says it. */
const NOT_READY = {
  "not-installed": "Not installed yet",
  "signed-out": "Not signed in yet",
  expired: "Its sign-in has expired",
  broken: "Not working",
} as const;

type Standing = Pick<AppWire, "inUse" | "standing" | "needs">;

/**
 * How a brain stands: the one turns think with says its login, or when its usage limit lifts.
 * Another is only worth the owner's attention while none can think.
 */
function brainStanding(row: BrainRow, thinking: string | null, timeZone: string): Standing {
  if (row.state === "ready" || row.state === "resting") {
    const resting = row.state === "resting" ? row.until : null;
    return {
      inUse: row.id === thinking,
      standing: resting
        ? `At its usage limit until ${clock(resting, timeZone)}`
        : row.id === thinking
          ? `On ${row.login}`
          : `Ready on ${row.login}, if the other stops`,
      needs: [],
    };
  }
  return {
    inUse: false,
    standing: thinking ? NOT_READY[row.state] : null,
    needs: thinking ? [] : [NOT_READY[row.state]],
  };
}

/** The app a holding sits at: who keeps it, or for a token in the wallet, the account that owns it. */
function keptAt(holding: Holding): string | undefined {
  return holding.venue === "wallet" ? accountOwning(holding)?.about.id : holding.venue;
}

/** What is open at a leveraged account: positions, and never the cash that waits beside them. */
const open = (holdings: readonly { readonly cash?: boolean }[]) =>
  holdings.filter((holding) => !holding.cash).length;

/** Why a leveraged account with positions open stays on, in the owner's words. */
function openPositions(count: number): string {
  return `You have ${count === 1 ? "a leveraged position" : `${count} leveraged positions`} open there, and Auni has to be able to close ${count === 1 ? "it" : "them"}.`;
}

/**
 * Why an app can't be turned off now, read afresh; null when it can. A leveraged position is
 * closed and stopped only through its own app's tools, so turning that app off would leave
 * neither Auni nor the specialist that manages the position able to act on it.
 */
export async function staysOn({ about, account }: App): Promise<string | null> {
  if (!account?.margined) return null;
  const { evm } = await walletAddresses();
  if (!evm) return null;
  try {
    const count = open(await keptOutsideWallet(account, evm as Address));
    return count > 0 ? openPositions(count) : null;
  } catch (error) {
    console.warn(`${about.name} couldn't be read before turning it off:`, error);
    return `Auni couldn't check ${about.name} for open positions just now, so it stays on. Try again in a minute.`;
  }
}

/** Where the owner's money sits at one app, from a reading of the whole portfolio. */
async function accountOf(
  { about, account }: App,
  read: Portfolio | null,
): Promise<Pick<AppWire, "account" | "stays">> {
  if (!account) return { account: null, stays: null };
  const words = (way: typeof account.moneyIn) => (typeof way === "string" ? way : null);
  const ways = { moneyIn: words(account.moneyIn), moneyOut: words(account.moneyOut) };
  // A source of its own that couldn't be read is named by its id (see readPortfolio).
  const unread = !read || read.unavailable.some((source) => source.split(" ")[0] === about.id);
  if (unread) return { account: { usd: null, holdings: [], ...ways }, stays: null };
  const held = read.holdings
    .filter((holding) => keptAt(holding) === about.id)
    .toSorted((a, b) => Number(b.usdValue ?? 0) - Number(a.usdValue ?? 0));
  const faces = await holdingFaces(held);
  const count = account.margined ? open(held) : 0;
  return {
    account: {
      usd: sumUsd(held.map((holding) => holding.usdValue ?? "0")),
      holdings: faces
        .map(({ id, name, detail, logoUrl, usdValue }) => ({ id, name, detail, logoUrl, usdValue }))
        // A crumb under a cent isn't something a person holds.
        .filter(({ usdValue }) => usdToCents(usdValue) > 0n),
      ...ways,
    },
    stays: count > 0 ? openPositions(count) : null,
  };
}

/** Every app as the owner sees it now. A setting's value is never among it: only whether it is set. */
export async function appsWire(): Promise<AppsWire> {
  const [rows, picked, chats, me, read, troubles, wallet, keyFields] = await Promise.all([
    brainRows(),
    pickBrain(),
    channelStates(),
    theOwner(),
    // What can't be read just now says so in its sheet; the list still shows.
    portfolioNow().catch((error: unknown) => {
      console.warn("The apps list couldn't read the portfolio:", error);
      return null;
    }),
    appTroublesNow(),
    walletAddresses().catch(() => null),
    settingFields(),
  ]);
  /** Whether a secret of an app's is typed into its private field, as that field says. */
  const typedIn = (app: string, key: string) =>
    keyFields.some(
      ({ id, inputs }) => id === settingField(app) && inputs.some(({ name }) => name === key),
    );
  const thinking = "about" in picked ? picked.about.id : null;
  const on = new Set(offered().map(({ about }) => about.id));
  return {
    settingsFile: settingsFile(),
    whichBrain: whichBrainSays(settingsFile()),
    apps: await Promise.all(
      apps().map(async (app): Promise<AppWire> => {
        const { id } = app.about;
        const brain = rows.find((row) => row.id === id);
        const chat = chats.find((channel) => channel.id === id);
        const closed = await closedHere(app);
        const lacks = walletLacks(app, wallet);
        const standing: Standing = brain
          ? brainStanding(brain, thinking, me.timeZone)
          : { inUse: inUse(app), standing: null, needs: [] };
        const pairing = chat
          ? chat.paired
            ? "paired"
            : chat.configured
              ? "ready"
              : "unset"
          : null;
        return {
          id,
          name: app.about.name,
          does: app.about.does ?? null,
          canSwitch: hasSwitch(app),
          on: on.has(id),
          jobs: jobsOf(app),
          ...standing,
          standing: pairing === "paired" ? "Paired with your chat" : standing.standing,
          needs: [
            ...standing.needs,
            ...unsetSettings(app).map(({ label }) => `Needs ${withArticle(label)}`),
            ...(lacks ? [`Needs ${lacks}, which Settings adds under Wallet`] : []),
            ...(pairing === "ready" ? ["Not paired yet"] : []),
          ],
          pairing,
          troubles: [
            // A service that takes no new positions from this machine says so first.
            ...(closed ? [closed] : []),
            ...troubles
              .filter((trouble) => trouble.app === id)
              .map((trouble) =>
                troubleWords(trouble, app.about.name, (at) => clock(at, me.timeZone)),
              ),
          ],
          settings: Object.entries(app.about.settings ?? {}).map(([key, declared]) => ({
            key,
            label: declared.label,
            kind: declared.kind,
            required: declared.required === true,
            help: declared.help ?? null,
            set: setBy(declared.env),
            untried: savedUntried(declared.env),
            field: typedIn(id, key) ? settingField(id) : null,
            env: declared.env,
          })),
          ...(await accountOf(app, read)),
        };
      }),
    ),
  };
}
