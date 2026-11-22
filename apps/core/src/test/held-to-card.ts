import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address as SolanaAddress,
} from "@solana/kit";
import {
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
  TokenInstruction,
} from "@solana-program/token";
import { AMOUNT, cardFaceSchema } from "@auni/shared";
import { decodeFunctionData, erc20Abi, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ActionRow } from "../db/schema.ts";
import { approvedDetails } from "../money/actions.ts";
import {
  APPROVED_PRICE_AT_LEAST,
  APPROVED_PRICE_AT_MOST,
  APPROVED_PROCEEDS,
  APPROVED_SALE,
} from "../money/approved.ts";
import { fitted } from "../money/card-face.ts";
import { effectLines } from "../money/effect.ts";
import { MayHaveSent, type Recipe } from "../money/recipe.ts";
import { recipeForTool } from "../money/recipes/index.ts";
import { SPL_TOKEN_PROGRAMS } from "../money/chains.ts";
import { recordingWallets, signedCount, type Signed } from "./wallets.ts";

// The shared proof that a money tool does what its card showed and nothing more, whatever
// happens between the card and the send. Every money tool Auni has, core's own and each
// app's, gives one drill to `holdsToCard`, in a test file beside the recipe, with the mocks
// that stand in for its world; money/held-to-card.test.ts fails for any tool without one.
//
//   holdsToCard("aave_supply", { world, asShown, paysAsShown, priceMoved, takesMore, paysElsewhere })
//
// Each call in `asShown` runs once in the world as it was when its card was drawn: the recipe
// must sign something, and `paysAsShown` reads what it signed against the card. Each hard case
// runs that way too, then again with its change made after the card was drawn and before
// execute: the recipe must refuse, with nothing signed, sent or recorded as sent. The first run
// is what makes the second mean something: the refusal comes from the change, not from a world
// the drill got wrong.
//
// Some of it a drill can't opt out of. `paysAsShown` must check something. A request the world
// doesn't answer fails the run, so it can't pass for a refusal. And each `asShown` call is run
// again with every bound its card pinned narrowed (NARROWED), which must refuse or still pay as
// that card shows: the card's own bounds are what execute is held to, not the agent's input.

/** One hard situation: a call the agent makes, and how the world changes after its card. */
interface Case {
  readonly input: Record<string, unknown>;
  readonly after: () => unknown;
}

/**
 * The cases of one hard situation, by what each is, or why it can't happen to this recipe at all
 * ("the card's amount is all it spends: no quote sizes it"), which a reviewer reads.
 */
type Cases = Readonly<Record<string, Case>> | { readonly never: string };

export interface Drill {
  /** Sets the world as each run finds it when its card is drawn: balances, prices, quotes. */
  readonly world: () => void | Promise<void>;
  /** Calls the agent makes, by what each is, which must sign only what their card showed. */
  readonly asShown: Readonly<Record<string, Record<string, unknown>>>;
  /**
   * Fails unless what the recipe signed on a run where nothing changed pays, spends and lands
   * exactly where its card said: the amount, the asset, and every address money goes to.
   */
  readonly paysAsShown: (signed: Signed, card: ActionRow) => void | Promise<void>;
  /** The price moved against the owner between the card and execute. */
  readonly priceMoved: Cases;
  /** Execute would sell or spend more than the card approved. */
  readonly takesMore: Cases;
  /** The money would go somewhere the card didn't show. */
  readonly paysElsewhere: Cases;
}

/**
 * A recipe whose execute isn't written yet, as `pnpm scaffold` writes one, named by itself since
 * its app may not be registered yet: it must send nothing, and once it sends, it needs a Drill.
 */
export interface Unwritten {
  readonly recipe: Recipe;
  readonly input: Record<string, unknown>;
  readonly sendsNothingYet: string;
}

/**
 * A recipe that only changes Auni's records and sends nothing (Recipe.offChain), which this
 * harness can't drive without a database: the tests beside the call hold its records to its
 * card, and say so here.
 */
export interface RecordsOnly {
  readonly recordsOnly: string;
}

const SITUATIONS = {
  priceMoved: "refuses once the price moved against the owner",
  takesMore: "refuses to sell or spend more than its card approved",
  paysElsewhere: "refuses to pay anywhere its card didn't show",
} as const satisfies Partial<Record<keyof Drill, string>>;

/** The action row recordActions keeps of a card, as execute is handed it. */
function cardOf(
  recipe: Recipe,
  input: Record<string, unknown>,
  preview: Awaited<ReturnType<Recipe["describe"]>>,
): ActionRow {
  return {
    id: "00000000-0000-4000-8000-0000000000c4",
    threadId: null,
    proposalId: null,
    summary: preview.summary,
    amountUsd: preview.amountUsd,
    status: "running",
    phase: "sending",
    venue: recipe.venue,
    tool: recipe.tool,
    input,
    lines: effectLines(preview.effect),
    details: approvedDetails(preview),
    run: {},
    card: preview.card ? fitted(preview.card) : null,
    txs: [],
    error: null,
    failureKind: null,
    attempts: 1,
    previousErrors: [],
    startedAt: new Date(),
    endedAt: null,
    stepUpAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** A figure that says what the owner pays or puts in, whose dollars are the card's amount. */
const PAYS = /^(you (pay|put in|spend)|amount)\b/iu;

/**
 * How a face a move wrote itself says its dollars: only as AMOUNT, which is filled with the
 * amount core priced, so it can't show a channel or the web dollars other than
 * the ones a pot and a permission are checked against: a card that spends says AMOUNT in its
 * title, its button or a figure, and neither its title, its button nor a figure of what the owner
 * pays types dollars of its own. Core's own sentence may say dollars (a withdrawal's title is its
 * summary), as the card shows it anyway. A move that writes no face gets the plain one core makes
 * from that sentence and the simulation's lines, which says nothing a move typed.
 */
function saysItsAmount(card: ActionRow): void {
  if (!card.card) return;
  const face = cardFaceSchema.parse(card.card);
  const typed = (words: string) => words !== card.summary && /\$\s*\d/u.test(words);
  for (const words of [face.title, face.action])
    expect(typed(words), `its face types dollars of its own: say AMOUNT (${words})`).toBe(false);
  for (const { label, value } of face.figures)
    if (PAYS.test(label))
      expect(typed(value), `"${label}" types dollars of its own: say AMOUNT (${value})`).toBe(
        false,
      );
  const says = [face.title, face.action, ...face.figures.map(({ value }) => value)];
  if (Number(card.amountUsd) > 0)
    expect(
      says.some((words) => words.includes(AMOUNT) || words === card.summary),
      "its face never says the card's amount: put AMOUNT where it goes",
    ).toBe(true);
}

/**
 * A card's words are plain data every channel draws its own way, so they read without a
 * separator character: no middle dot and no em dash, in its sentence, its lines or its face.
 * ("Opened a long on BTC", never "Opened long \u00b7 BTC".) ESLint holds the same of every
 * string core, the web and shared write (eslint.config.mjs).
 */
function readsPlainly(card: ActionRow): void {
  const words = JSON.stringify([card.summary, card.lines, card.card]);
  expect(
    /[\u00b7\u2014]/u.test(words),
    `its card joins words with a middle dot or an em dash: ${words}`,
  ).toBe(false);
}

/** A request a run made, and whether anything answered it. */
interface Reached {
  readonly url: string;
  readonly answered: boolean;
}

/** Runs `body` with every request it makes over fetch kept in `requests`, answered or not. */
async function watchingRequests<T>(requests: Reached[], body: () => Promise<T>): Promise<T> {
  const fetched = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    try {
      const answer = await fetched(...args);
      requests.push({ url, answered: true });
      return answer;
    } catch (error) {
      requests.push({ url, answered: false });
      throw error;
    }
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = fetched;
  }
}

/**
 * Draws the card in the drill's world, makes `after`'s change, then runs execute on the card as
 * `change` leaves it (as drawn, by default).
 */
async function run(
  recipe: Recipe,
  world: Drill["world"],
  raw: Record<string, unknown>,
  {
    after,
    change = (card) => card,
  }: { after?: Case["after"]; change?: (card: ActionRow) => ActionRow } = {},
) {
  await world();
  const input = z.object(recipe.input).parse(raw);
  const card = change(cardOf(recipe, input, await recipe.describe(input, {})));
  await after?.();
  const wallets = recordingWallets();
  const recorded: unknown[] = [];
  const requests: Reached[] = [];
  const outcome = await watchingRequests(requests, () =>
    recipe.execute({
      action: card,
      input,
      wallets,
      recordSent: async (tx) => {
        recorded.push(tx);
      },
      // As core keeps a post (see executeAction): marked before it goes, unmarked if refused.
      posting: async (chain, post) => {
        const mark = { chain };
        recorded.push(mark);
        try {
          return await post();
        } catch (error) {
          if (!(error instanceof MayHaveSent)) recorded.splice(recorded.indexOf(mark), 1);
          throw error;
        }
      },
    }),
  ).then(
    () => ({ refused: null }),
    (error: unknown) => ({ refused: error }),
  );
  // A request nothing answered fails a run on its own: a refusal must come from a guard.
  const unanswered = requests.filter(({ answered }) => !answered).map(({ url }) => url);
  expect(unanswered, "the drill's world answers none of these, so give it one").toEqual([]);
  return { card, signed: wallets.signed, recorded, requests, ...outcome };
}

/**
 * The card with each bound it pinned narrowed past what an unchanged world gives: it sells
 * less, gets more, and pays a better price than execute can. A card's own bounds are what
 * execute is held to, so each must refuse, or sign what `paysAsShown` passes for that card.
 */
const NARROWED: Readonly<Record<string, (shown: number) => number>> = {
  [APPROVED_SALE]: (shown) => shown / 2,
  [APPROVED_PROCEEDS]: (shown) => shown * 2,
  [APPROVED_PRICE_AT_MOST]: (shown) => shown / 2,
  [APPROVED_PRICE_AT_LEAST]: (shown) => shown * 2,
};

function narrowed(card: ActionRow, key: string): ActionRow {
  const shown = Number(card.details[key]);
  const now = NARROWED[key]!(shown);
  return { ...card, details: { ...card.details, [key]: now.toFixed(18).replace(/\.?0+$/u, "") } };
}

function registered(tool: string): Recipe {
  const recipe = recipeForTool(tool);
  if (!recipe) throw new Error(`No recipe is registered for ${tool}.`);
  return recipe;
}

/** Proves the money tool `tool`, as Auni registers it, is held to its card (see Drill). */
export function holdsToCard(tool: string, drill: Drill | Unwritten | RecordsOnly): void {
  describe(`${tool} is held to its card`, () => {
    if ("recordsOnly" in drill) {
      it(`sends nothing, since it only changes Auni's records: ${drill.recordsOnly}`, () => {
        expect(registered(tool).offChain).toBe(true);
      });
      return;
    }
    if ("sendsNothingYet" in drill) {
      it(`sends nothing while ${drill.sendsNothingYet}`, async () => {
        expect(drill.recipe.tool).toBe(tool);
        const ran = await run(drill.recipe, () => {}, drill.input);
        expect(signedCount(ran.signed), "it signed something: give it a drill").toBe(0);
        expect(ran.recorded).toEqual([]);
        // A venue's API can move money too, so an unwritten execute asks nothing of one.
        expect(ran.requests, "it reached a service: give it a drill").toEqual([]);
      });
      return;
    }
    /** Reads what was signed against `card` with the drill's paysAsShown, which must check something. */
    const paysAsShown = async (signed: Signed, card: ActionRow) => {
      const before = expect.getState().assertionCalls;
      await drill.paysAsShown(signed, card);
      expect(expect.getState().assertionCalls, "paysAsShown checked nothing").toBeGreaterThan(
        before,
      );
    };
    /** Runs `input` with nothing changed, which must sign what its card showed and only that. */
    const asShown = async (recipe: Recipe, input: Record<string, unknown>) => {
      const shown = await run(recipe, drill.world, input);
      expect(shown.refused, "it refused with nothing changed since its card").toBeNull();
      expect(signedCount(shown.signed), "it signed nothing").toBeGreaterThan(0);
      await paysAsShown(shown.signed, shown.card);
      saysItsAmount(shown.card);
      readsPlainly(shown.card);
      return shown.card;
    };
    for (const [name, input] of Object.entries(drill.asShown)) {
      it(`signs only what its card showed: ${name}`, async () => {
        const recipe = registered(tool);
        const card = await asShown(recipe, input);
        // The hard case every recipe gets, whatever its drill says: a card that approved less.
        for (const key of Object.keys(NARROWED).filter((key) => key in card.details)) {
          const held = await run(recipe, drill.world, input, {
            change: (drawn) => narrowed(drawn, key),
          });
          if (held.refused !== null) {
            expect(held.signed, `it refused under a narrower ${key} but signed`).toEqual({
              evm: [],
              solana: [],
              typed: [],
            });
            expect(held.recorded).toEqual([]);
          } else await paysAsShown(held.signed, held.card);
        }
      });
    }
    for (const [situation, title] of Object.entries(SITUATIONS)) {
      const cases = drill[situation as keyof typeof SITUATIONS];
      if ("never" in cases) continue;
      for (const [name, each] of Object.entries(cases as Record<string, Case>)) {
        it(`${title}: ${name}`, async () => {
          const recipe = registered(tool);
          await asShown(recipe, each.input);
          const moved = await run(recipe, drill.world, each.input, { after: each.after });
          expect(moved.refused, "it went ahead after the change").not.toBeNull();
          expect(moved.signed).toEqual({ evm: [], solana: [], typed: [] });
          expect(moved.recorded).toEqual([]);
        });
      }
    }
  });
}

/** An ERC-20 transfer or approval the wallet was asked to send: whom it pays or lets spend, and how much. */
export interface Erc20Call {
  readonly chainId: number;
  /** The token contract, checksummed. */
  readonly token: string;
  readonly call: "transfer" | "approve";
  /** Who is paid, or who may spend, checksummed. */
  readonly to: string;
  readonly units: bigint;
}

/** Every ERC-20 transfer and approval in what the wallet sent, in order; other calls are left out. */
export function erc20Calls(signed: Signed): Erc20Call[] {
  return signed.evm.flatMap(({ chainId, txs }) =>
    txs.flatMap((tx) => {
      try {
        const { functionName, args } = decodeFunctionData({
          abi: erc20Abi,
          data: (tx.data ?? "0x") as `0x${string}`,
        });
        if (functionName !== "transfer" && functionName !== "approve") return [];
        const [to, units] = args as readonly [string, bigint];
        return [
          { chainId, token: getAddress(tx.to), call: functionName, to: getAddress(to), units },
        ];
      } catch {
        return [];
      }
    }),
  );
}

/** An SPL token transfer the wallet was asked to send on Solana. */
export interface SolanaTransfer {
  readonly mint: string;
  /** The token account it pays, which belongs to its recipient. */
  readonly destination: string;
  readonly amount: bigint;
}

/** Every SPL TransferChecked in what the wallet sent on Solana, in order. */
export function solanaTransfers(signed: Signed): SolanaTransfer[] {
  return signed.solana.flatMap(({ base64Tx }) => {
    const { messageBytes } = getTransactionDecoder().decode(getBase64Encoder().encode(base64Tx));
    const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
    // Auni builds legacy and v0 messages, which list their instructions this way.
    if (!("instructions" in message)) throw new Error("A Solana message Auni doesn't build.");
    return message.instructions.flatMap((compiled) => {
      const programAddress = message.staticAccounts[compiled.programAddressIndex]!;
      const data = compiled.data;
      if (!(SPL_TOKEN_PROGRAMS as readonly string[]).includes(programAddress) || !data) return [];
      if (identifyTokenInstruction(data) !== TokenInstruction.TransferChecked) return [];
      const parsed = parseTransferCheckedInstruction({
        programAddress: programAddress as SolanaAddress<typeof programAddress>,
        accounts: (compiled.accountIndices ?? []).map((index) => ({
          address: message.staticAccounts[index]!,
          role: 0,
        })),
        data,
      } as never);
      return [
        {
          mint: parsed.accounts.mint.address,
          destination: parsed.accounts.destination.address,
          amount: parsed.data.amount,
        },
      ];
    });
  });
}
