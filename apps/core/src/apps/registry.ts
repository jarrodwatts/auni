import { NETWORKS, type AppAbout } from "@auni/shared";

import { env } from "../env.ts";
import { fillIdentity, type FillKey } from "../money/fill-key.ts";
import type { Recipe } from "../money/recipe.ts";
import { appsOff } from "../settings.ts";
import type {
  Account,
  AccountCash,
  AccountToken,
  App,
  Brain,
  Bridge,
  Channel,
  NoNewPositions,
  SavingsToken,
  Source,
  WalletProvider,
} from "./contract.ts";
import { APPS } from "./index.generated.ts";
import { ASKED_FIRST } from "./order.ts";

// Core's only door to the apps. Loading an app never loads this file (apps.test.ts), so
// every app has loaded before anything here is read. Registry order is the generated list's:
// by folder id.

let installed: readonly App[] = APPS;

export function apps(): readonly App[] {
  return installed;
}

/**
 * Has core work with `stood` in place of the apps in the folders, from here on. Only demo
 * mode calls it (demo/start.ts), before anything has read an app: its brain and wallet stand
 * in for every app that thinks or signs, so a demo never runs a real CLI or reaches a key.
 */
export function standIn(stood: (real: readonly App[]) => readonly App[]): void {
  installed = stood(APPS);
}

export function appById(id: string): App | undefined {
  return apps().find((app) => app.about.id === id);
}

/**
 * Whether the owner may turn an app off: only one they act through (it has money tools,
 * lookups, a reader, a channel, or know-how for Claude), and never one core's own work runs on
 * (a swap route, a bridge, a price feed, the wallet, a brain). So nothing core depends on can be
 * switched away.
 */
export function hasSwitch(app: App): boolean {
  const actedThrough = Boolean(
    app.moves?.length || app.lookups || app.reads || app.channel || app.guide,
  );
  const coreRunsOn = Boolean(
    app.swaps || app.solana || app.bridge || app.payIn || app.tokens || app.wallet || app.brain,
  );
  return actedThrough && !coreRunsOn;
}

/**
 * The apps the owner has not turned off (see hasSwitch). The switch changes only what the
 * agent is offered (tools, guides, what it can find and watch with) and which channels and
 * sources run. Everything that reads, prices, settles or finishes what already exists asks
 * apps(), whatever the switch says: a move already allowed still runs, a holding is still
 * read and priced, and a send still reconciles.
 */
export function offered(): readonly App[] {
  const off = appsOff();
  return apps().filter((app) => !(off.has(app.about.id) && hasSwitch(app)));
}

/**
 * Why `app` takes no new positions from this machine now (App.noNewPositions), or null. A check
 * that throws is read as taking them, as one that can't reach its service does.
 */
export async function closedHere(app: App | undefined): Promise<NoNewPositions | null> {
  try {
    return (await app?.noNewPositions?.()) ?? null;
  } catch (error) {
    console.warn(`${app?.about.name ?? "An app"}'s region check failed:`, error);
    return null;
  }
}

/** The money tools of the apps in `from`: every app's, unless told the offered ones. */
export function appRecipes(from: readonly App[] = apps()): readonly Recipe[] {
  return from.flatMap((app) => app.moves ?? []);
}

/** An app's account, with the app it is at. */
export interface Kept {
  readonly about: AppAbout;
  readonly account: Account;
}

/** Every app's account, in registry order: where the owner's money sits beyond plain tokens. */
export function accounts(): readonly Kept[] {
  return apps().flatMap(({ about, account }) => (account ? [{ about, account }] : []));
}

/** The account of the app with this id, which a holding's `venue` and a recipe's name. */
export function accountOf(id: string): Kept | undefined {
  return accounts().find(({ about }) => about.id === id);
}

/**
 * The account a holding is its own of, if any: it prices and names it. Each way an account is
 * kept owns in its own way (see Account.kept): a wallet's tokens are the ones listed, a ledger's
 * are everything filed under its app's id, and contracts on chains own what they say of a key on
 * one of their chains.
 */
export function accountOwning(key: FillKey): Kept | undefined {
  const ledger = ledgerAt(key.chain);
  if (ledger) return ledger;
  const identity = fillIdentity(key);
  return accounts().find(({ account: { kept } }) => {
    if ("wallet" in kept) return kept.wallet.some((token) => fillIdentity(token) === identity);
    return "chains" in kept && kept.chains.some((chain) => chain === key.chain) && kept.owns(key);
  });
}

/** The token an account keeps in the owner's wallet that `key` names, if one does. */
export function accountToken(key: FillKey): AccountToken | undefined {
  const identity = fillIdentity(key);
  for (const { account } of accounts())
    if ("wallet" in account.kept)
      for (const token of account.kept.wallet) if (fillIdentity(token) === identity) return token;
  return undefined;
}

/**
 * The account that keeps its money in a ledger of its own, whose id `place` (a fill's chain, a
 * cash place) is. This is the one way core asks "is this place a ledger, and not a chain": a
 * send to a ledger has no chain receipt, so answering it for a real chain would record a
 * reverted send as done. An account kept in a wallet or on chains is never found here, and no
 * app's id is a network's (apps.test.ts holds both).
 */
export function ledgerAt(place: string): (Kept & { readonly ledger: Ledger }) | undefined {
  // A network is never a ledger, whatever an app calls itself.
  if (Object.hasOwn(NETWORKS, place)) return undefined;
  for (const { about, account } of accounts())
    if (about.id === place && "ledger" in account.kept)
      return { about, account, ledger: account.kept.ledger };
  return undefined;
}

type Ledger = Extract<Account["kept"], { readonly ledger: unknown }>["ledger"];

/** Whether a holding is leveraged: a position that can be short, worth its margin plus what it made. */
export function isMargined(key: FillKey): boolean {
  return accountOwning(key)?.account.margined === true;
}

/** Each account's savings on `chain` (see AccountCash), with the app it is at. */
export function savingsTokens(
  chain: string,
): readonly (SavingsToken & { readonly about: AppAbout })[] {
  return accounts().flatMap(({ about, account }) => {
    const kept = account.cash?.kind === "savings" ? account.cash.token(chain) : null;
    return kept ? [{ ...kept, about }] : [];
  });
}

/** Every account whose cash is dollar tokens on a chain, which a buy there spends (see AccountCash). */
export function chainCash(): readonly {
  readonly about: AppAbout;
  readonly cash: Extract<AccountCash, { readonly kind: "chain" }>;
}[] {
  return accounts().flatMap(({ about, account }) =>
    account.cash?.kind === "chain" ? [{ about, cash: account.cash }] : [],
  );
}

/** The jobs an app does for core itself, which core asks for by name. */
type AppRole = "brain" | "swaps" | "solana" | "bridge" | "payIn" | "tokens";

/**
 * Every app that does this job, with that part of it: in the order order.ts gives for a role
 * where the first answer wins, else in registry order. An app order.ts doesn't list comes
 * after those it does (apps.test.ts fails a real one that isn't listed).
 */
export function filling<Kind extends AppRole>(
  kind: Kind,
): readonly {
  readonly about: AppAbout;
  readonly part: NonNullable<App[Kind]>;
}[] {
  const found = apps().flatMap((app) => {
    const part = app[kind];
    return part ? [{ about: app.about, part }] : [];
  });
  const order: readonly string[] | undefined = Object.hasOwn(ASKED_FIRST, kind)
    ? ASKED_FIRST[kind as keyof typeof ASKED_FIRST]
    : undefined;
  if (!order) return found;
  const place = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return found.toSorted((a, b) => place(a.about.id) - place(b.about.id));
}

/** Whether cash kept at the app `venue` names is savings: its account counts its cash as that. */
export function isSavings(venue: string): boolean {
  return accountOf(venue)?.account.cash?.kind === "savings";
}

/**
 * The bridge core's own moves quote through (withdrawals, paying a card from another chain): the
 * first order.ts names. A card pins the one it was quoted on (a withdrawal's details.bridge, a
 * payment leg's tool), and its move goes through that one.
 */
export function firstBridge(): { readonly about: AppAbout; readonly bridge: Bridge } {
  const [first] = filling("bridge");
  if (!first) throw new Error("No app provides a bridge.");
  return { about: first.about, bridge: first.part };
}

/**
 * The one app that provides something, for a kind core uses exactly one of (the wallet).
 */
function theOne<Provided>(
  provides: (app: App) => Provided | undefined,
  does: string,
): { readonly about: AppAbout; readonly provided: Provided } {
  const found = apps().flatMap((app) => {
    const provided = provides(app);
    return provided ? [{ about: app.about, provided }] : [];
  });
  if (found.length !== 1)
    throw new Error(`Auni needs exactly one app that ${does}; ${found.length} do.`);
  return found[0]!;
}

/** The app that holds the owner's wallets and signs for them: the one WALLET names, or the default. */
export function walletApp(): { readonly about: AppAbout; readonly provided: WalletProvider } {
  const named = env.WALLET;
  return theOne(
    (app) => ((named ? app.about.id === named : app.wallet?.byDefault) ? app.wallet : undefined),
    named ? `holds wallets and is named ${named} (WALLET)` : "holds wallets by default",
  );
}

/** The wallet itself (see walletApp). */
export function theWallet(): WalletProvider {
  return walletApp().provided;
}

/** Every app that can think, in the order order.ts gives; agent/brain.ts picks one per turn. */
export function brains(): readonly { readonly about: AppAbout; readonly brain: Brain }[] {
  return filling("brain").map(({ about, part }) => ({ about, brain: part }));
}

/**
 * Each app in `from` the owner can talk to Auni through, set up or not: every one, unless
 * told the offered ones, which are those the hub listens on and sends to.
 */
export function channels(
  from: readonly App[] = apps(),
): readonly { readonly about: AppAbout; readonly channel: Channel }[] {
  return from.flatMap(({ about, channel }) => (channel ? [{ about, channel }] : []));
}

/** Every app that is on and says what it sees of the owner (see App.facts). */
export function factSources(): readonly {
  readonly about: AppAbout;
  readonly facts: NonNullable<App["facts"]>;
}[] {
  return offered().flatMap(({ about, facts }) => (facts ? [{ about, facts }] : []));
}

export interface InstalledSource {
  readonly about: AppAbout;
  readonly source: Source;
}

/**
 * Each app in `from` that can watch the world for something, in registry order: every one,
 * unless told the offered ones, which are those that run and that the agent may watch with.
 */
export function sources(from: readonly App[] = apps()): readonly InstalledSource[] {
  return from.flatMap(({ about, watches }) => (watches ? [{ about, source: watches }] : []));
}

/** The source a watch names, by its app id. */
export function sourceById(id: string): InstalledSource | undefined {
  return sources().find(({ about }) => about.id === id);
}
