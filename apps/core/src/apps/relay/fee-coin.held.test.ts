import { readFileSync } from "node:fs";

import { NETWORKS } from "@auni/shared";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  type Address,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { feeCoinFor, payingFees } from "../../money/fee-coin.ts";
import { feeCoinsSaid, feeCoinUsd, withFeeCoin } from "../../money/fee-coin-said.ts";
import { permissionDecision } from "../../money/permission.ts";
import type { PayInRequest } from "../../money/pay-in.ts";
import {
  FeesUnpaid,
  NothingMoved,
  type ActionPreview,
  type EvmTx,
  type KeptTx,
} from "../../money/recipe.ts";
import { recordingWallets, type Signed } from "../../test/wallets.ts";
import { answered, deposit, DEPOSITORY } from "./relay.ts";

// The coin a chain's fees are paid in, bought on a card through Relay (money/fee-coin.ts), held
// to that card the way every money tool is (test/held-to-card.ts): what is signed is exactly
// the card's amount, into Relay's depository, and nothing else; and once the world moves past
// the card, nothing is signed at all. It is no tool of its own, so it is drilled here, against
// Relay's answers recorded on 2026-11-13 for the two ways it pays (./fixtures).
//
// The world is the wallet of the live test of that day: cash on Arbitrum and none of its ETH,
// 67 MON on Monad and 3 cents of USDC there.

const OWNER: Address = "0x2222222222222222222222222222222222222222";
const SOMEONE: Address = "0x3333333333333333333333333333333333333333";
const ARBITRUM = NETWORKS.arbitrum.viem.id;
const MONAD = NETWORKS.monad.viem.id;
const MON = 10n ** 18n;
/** What a bridge's approval and deposit on Arbitrum were short: 0.000012 ETH, a few cents. */
const LACKS = 12n * 10n ** 12n;
/** A quarter of a dollar of MON at the world's price, which is what the card buys the ETH with. */
const QUARTER_OF_MON = 15_151_515_152n * 10n ** 9n;

type Recorded = {
  steps: { id: string; items: { data: Record<string, string | number> }[] }[];
  details: { recipient: string; currencyOut: { amount: string; minimumAmount: string } };
};
const recorded = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Recorded;

const depository = parseAbi([
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);

/**
 * Relay's recorded answer for the kind of request this is, for the chain, token and amount it
 * names: what it pays out scales with what is sent, as Relay's own quotes do.
 */
function relayAnswers(request: PayInRequest): Recorded {
  const coin = request.from.token === "native";
  const answer = recorded(
    coin ? "quote-monad-coin-to-arbitrum-coin" : "quote-monad-usdc-to-arbitrum-coin",
  );
  const sentThen = coin ? 30n * MON : 1_000_000n;
  const scaled = (units: string) => ((BigInt(units) * request.amount) / sentThen).toString();
  const out = answer.details.currencyOut;
  answer.details.currencyOut = {
    ...out,
    amount: scaled(out.amount),
    minimumAmount: scaled(out.minimumAmount),
  };
  const call = (id: string) => answer.steps.find((step) => step.id === id)!.items[0]!.data;
  for (const step of answer.steps) call(step.id).chainId = NETWORKS[request.from.chain].viem.id;
  if (coin) call("deposit").value = request.amount.toString();
  else {
    const [depositor, , , id] = decodeFunctionData({
      abi: depository,
      data: call("deposit").data as `0x${string}`,
    }).args;
    const token = request.from.token as Address;
    call("approve").to = token;
    call("approve").data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [DEPOSITORY, request.amount],
    });
    call("deposit").data = encodeFunctionData({
      abi: depository,
      functionName: "depositErc20",
      args: [depositor, token, request.amount, id],
    });
  }
  return answer;
}

const world = vi.hoisted(() => ({
  coin: {} as Record<number, bigint>,
  usdc: {} as Record<number, bigint>,
  /** What a send on each chain is short of its coin, in wei. */
  lacks: {} as Record<number, bigint>,
  sponsored: new Set<number>(),
  /** Where Relay says an order already made stands. */
  order: "pending" as "pending" | "success" | "refunded" | "failed",
  /** What Relay answers differently from its recorded answer, after a card was drawn. */
  now: (answer: unknown) => answer,
  asked: [] as unknown[],
}));

vi.mock(import("../../money/chains.ts"), async (original) => ({
  ...(await original()),
  evmClient: ((chainId: number) => ({
    getBalance: async () => world.coin[chainId] ?? 0n,
    readContract: async () => world.usdc[chainId] ?? 0n,
  })) as never,
}));
vi.mock(import("../../money/gas.ts"), () => ({
  ownGas: vi.fn(async (chainId: number) => {
    const lacks = world.lacks[chainId];
    return lacks ? { short: "Too little ETH for gas.", fee: 1n, lacks } : { short: null, fee: 1n };
  }),
  ownGasFees: vi.fn(),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => OWNER,
  paysOwnGas: async (chain: number | "solana") => !world.sponsored.has(chain as number),
}));
vi.mock(import("../../money/token-feeds.ts"), async (original) => ({
  ...(await original()),
  feedListing: (async (chain: string) => ({
    usdPrice: chain === "monad" ? 0.0165 : chain === "polygon" ? 0.2 : 2_000,
  })) as never,
}));
vi.mock(import("../../money/portfolio.ts"), async (original) => ({
  ...(await original()),
  readPortfolioShared: async () => ({ holdings: [] }) as never,
}));
// Core finds the pay-in app in the registry, which an app's test never names. So Relay's answer
// is handed straight to core's own check of it, as a live quote is (checkedQuote), and Relay
// says at once that it paid (the wait for that is tested with pay-in's own callers).
vi.mock(import("../../money/pay-in.ts"), async (original) => {
  const real = await original();
  return {
    ...real,
    payInQuote: async (request: PayInRequest) => {
      world.asked.push(request);
      return real.checkedQuote(
        request,
        { name: "Relay", depository: DEPOSITORY, deposit },
        answered(world.now(relayAnswers(request))),
      );
    },
    payInSettled: async () => ({ status: "success", paidIn: [] }),
    payInStanding: async () => ({ status: world.order, paidIn: [] }),
  };
});

/** The live wallet (see the top), with nothing changed since any card. */
beforeEach(() => {
  world.coin = { [MONAD]: 67n * MON };
  world.usdc = { [MONAD]: 32_221n, [ARBITRUM]: 5_504_117n };
  world.lacks = { [ARBITRUM]: LACKS };
  world.sponsored = new Set();
  world.now = (answer) => answer;
  world.order = "pending";
  world.asked = [];
});

/** A bridge's approval and deposit on Arbitrum, as its card says it would send them. */
const calls: EvmTx[] = [
  { to: NETWORKS.arbitrum.usdc!, data: "0x095ea7b3", setup: true },
  { to: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A", data: "0xad5425c6" },
];
const move: ActionPreview = {
  summary: "Move $2 of USDC from Arbitrum to Monad",
  amountUsd: "2",
  effect: { gives: [{ text: "$2 of USDC on Arbitrum" }], gets: [], grants: [] },
  details: { arrivesOn: "Monad" },
  sends: { chainId: ARBITRUM, calls },
};

/** The card as core draws it (prepareLeg in money/actions.ts): the move, and the coin it buys. */
async function card(): Promise<ActionPreview> {
  const bought = await feeCoinFor(move.sends!);
  return bought ? withFeeCoin(move, bought) : move;
}

/**
 * Runs the move's send on Arbitrum with the wallet execute hands a recipe (payingFees), and
 * says what was signed. Relay pays out as the deposit lands, as it does within a second or two.
 */
async function run(details: Record<string, string>, txs: readonly KeptTx[] = []) {
  const wallets = recordingWallets();
  const paid: typeof wallets = {
    ...wallets,
    async sendEvmTransaction(chainId, tx) {
      if (chainId === MONAD) {
        world.coin[ARBITRUM] = (world.coin[ARBITRUM] ?? 0n) + 10n * LACKS;
        world.lacks = {};
      }
      return wallets.sendEvmTransaction(chainId, tx);
    },
  };
  const signer = async () => ({ ...paid, evmAddress: OWNER });
  const outcome = await (
    await payingFees({ details, txs: [...txs] }, signer, async () => {})
  )
    .sendEvmTransaction(ARBITRUM, calls)
    .then(
      () => ({ refused: null }),
      (error: unknown) => ({ refused: error }),
    );
  return { signed: wallets.signed as Signed, ...outcome };
}

const NOTHING = { evm: [], solana: [], typed: [] };

describe("the coin a card buys for a chain's fees is held to its card", () => {
  it("signs only what its card showed: MON on Monad into Relay's depository, then the move", async () => {
    const shown = await card();
    expect(shown.details).toMatchObject({
      feeCoinOn: "arbitrum",
      feeCoinFrom: "monad",
      feeCoinToken: "native",
      feeCoinAmount: QUARTER_OF_MON.toString(),
      feeCoinUsd: "0.25",
      feeCoinBy: "Relay",
    });
    // No cost, as what the fees don't use of the ETH stays the owner's: the card's costs are the
    // move's own, and its words say the purchase (below).
    expect(shown.effect).toEqual(move.effect);
    const { signed, refused } = await run(shown.details!);
    expect(refused).toBeNull();
    const [purchase, sent, ...more] = signed.evm;
    // One deposit that carries exactly the card's MON, from the wallet, and nothing approved.
    expect(purchase!.chainId).toBe(MONAD);
    expect(purchase!.txs).toHaveLength(1);
    const [deposited] = purchase!.txs;
    expect(getAddress(deposited!.to)).toBe(getAddress(DEPOSITORY));
    expect(deposited!.value).toBe(shown.details!.feeCoinAmount);
    expect(deposit(deposited!.data as `0x${string}`, BigInt(deposited!.value!))).toEqual({
      depositor: OWNER,
      token: "native",
      amount: QUARTER_OF_MON,
    });
    expect(deposited!.setup).toBe(true);
    // Then the move itself, as the recipe sent it, and nothing after.
    expect(sent).toEqual({ chainId: ARBITRUM, txs: calls });
    expect(more).toEqual([]);
    expect([signed.solana, signed.typed]).toEqual([[], []]);
    // Relay was asked to pay the wallet itself, in Arbitrum's own coin.
    expect(world.asked.at(-1)).toMatchObject({
      user: OWNER,
      recipient: OWNER,
      to: { chain: "arbitrum", token: "native" },
    });
  });

  it("signs only what its card showed: an exact approval and a deposit of USDC, where Monad holds cash", async () => {
    world.usdc[MONAD] = 5_000_000n;
    const shown = await card();
    expect(shown.details).toMatchObject({
      feeCoinToken: NETWORKS.monad.usdc,
      feeCoinAmount: "250000",
    });
    const { signed, refused } = await run(shown.details!);
    expect(refused).toBeNull();
    const [purchase, sent] = signed.evm;
    expect(purchase!.chainId).toBe(MONAD);
    const [approve, deposited, ...more] = purchase!.txs;
    expect(more).toEqual([]);
    expect(getAddress(approve!.to)).toBe(NETWORKS.monad.usdc);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: approve!.data as `0x${string}` }).args,
    ).toEqual([getAddress(DEPOSITORY), 250_000n]);
    expect(deposit(deposited!.data as `0x${string}`, 0n)).toEqual({
      depositor: OWNER,
      token: NETWORKS.monad.usdc,
      amount: 250_000n,
    });
    expect([approve!.value, deposited!.value]).toEqual([undefined, undefined]);
    expect(sent).toEqual({ chainId: ARBITRUM, txs: calls });
  });

  it("spends the card's own amount, whatever the price is by then: a card that showed less deposits less", async () => {
    const shown = await card();
    const less = { ...shown.details!, feeCoinAmount: (QUARTER_OF_MON / 2n).toString() };
    const { signed, refused } = await run(less);
    expect(refused).toBeNull();
    expect(signed.evm[0]!.txs[0]!.value).toBe(less.feeCoinAmount);
  });

  it("buys nothing where the send isn't short by then, so a card spends what it showed on fees or nothing", async () => {
    const shown = await card();
    world.lacks = {};
    const { signed } = await run(shown.details!);
    expect(signed.evm).toEqual([{ chainId: ARBITRUM, txs: calls }]);
    expect(world.asked).toHaveLength(1);
  });

  it("refuses once the price moved against the owner: the card's amount no longer buys what the send is short", async () => {
    const shown = await card();
    world.now = (answer) => {
      const quote = answer as Recorded;
      quote.details.currencyOut.minimumAmount = (LACKS - 1n).toString();
      return quote;
    };
    const { signed, refused } = await run(shown.details!);
    expect(refused).toBeInstanceOf(NothingMoved);
    expect(String(refused)).toContain(
      "ETH for Arbitrum's network fee costs more now than the 15.1515 MON its card showed buying it with, so nothing was sent.",
    );
    expect(signed).toEqual(NOTHING);
  });

  it.each([
    ["a deposit that carries a wei more", { value: (QUARTER_OF_MON + 1n).toString() }],
    ["a deposit that carries twice the amount", { value: (QUARTER_OF_MON * 2n).toString() }],
  ])("refuses to spend more than its card approved: %s", async (_what, change) => {
    const shown = await card();
    world.now = (answer) => {
      const quote = answer as Recorded;
      Object.assign(quote.steps[0]!.items[0]!.data, change);
      return quote;
    };
    const { signed, refused } = await run(shown.details!);
    expect(String(refused)).toContain("Relay's quote carries something other than the amount");
    expect(signed).toEqual(NOTHING);
  });

  const elsewhere: [string, (quote: Recorded) => void][] = [
    ["Relay says it pays someone else", (quote) => (quote.details.recipient = SOMEONE)],
    [
      "the deposit goes to another contract",
      (quote) => (quote.steps[0]!.items[0]!.data.to = SOMEONE),
    ],
    [
      "the deposit is in someone else's name",
      (quote) =>
        (quote.steps[0]!.items[0]!.data.data = encodeFunctionData({
          abi: parseAbi(["function depositNative(address depositor, bytes32 id) payable"]),
          functionName: "depositNative",
          args: [SOMEONE, `0x${"00".repeat(32)}`],
        })),
    ],
    [
      "an approval comes with it",
      (quote) =>
        quote.steps.unshift({
          ...quote.steps[0]!,
          id: "approve",
          items: [
            {
              data: {
                ...quote.steps[0]!.items[0]!.data,
                to: NETWORKS.monad.usdc!,
                value: "0",
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [DEPOSITORY, 2n ** 256n - 1n],
                }),
              },
            },
          ],
        }),
    ],
  ];
  it.each(elsewhere)("refuses to pay anywhere its card didn't show: %s", async (_what, change) => {
    const shown = await card();
    world.now = (answer) => {
      change(answer as Recorded);
      return answer;
    };
    const { signed, refused } = await run(shown.details!);
    expect(String(refused)).toContain("so Auni won't hand it on");
    expect(signed).toEqual(NOTHING);
  });

  it("signs nothing on a later run of a card that already bought, whatever Relay says of the order", async () => {
    // Try again, after a run that made the card's purchase and stopped (see fee-coin.db.test.ts
    // for the whole run): the send is still short, and the card buys once.
    const shown = await card();
    const bought = { chain: "monad", hash: "0xbought", setup: true as const, buysFees: "0xorder" };
    for (const order of ["pending", "refunded", "failed", "success"] as const) {
      world.order = order;
      const { signed, refused } = await run(shown.details!, [bought]);
      expect(refused).toBeInstanceOf(FeesUnpaid);
      expect(signed).toEqual(NOTHING);
    }
    // Relay was never asked for another quote.
    expect(world.asked).toHaveLength(1);
    // Once the coin has come, the same run sends the move and nothing else.
    world.lacks = {};
    const late = await run(shown.details!, [bought]);
    expect(late.refused).toBeNull();
    expect(late.signed.evm).toEqual([{ chainId: ARBITRUM, txs: calls }]);
  });

  it("lets one run make one purchase: a second send that buys is refused with nothing signed", async () => {
    // The door every purchase goes through, whoever makes it: here a move that buys for itself,
    // as a move on Solana does (money/sol-top-up.ts), and then tries to buy again.
    const shown = await card();
    const wallets = recordingWallets();
    const handed = await payingFees(
      { details: shown.details!, txs: [] },
      async () => wallets,
      async () => {},
    );
    const purchase = [{ to: DEPOSITORY, data: "0x", setup: true as const, buysFees: "0xorder" }];
    await handed.sendEvmTransaction(MONAD, purchase);
    await expect(handed.sendEvmTransaction(MONAD, purchase)).rejects.toThrow(FeesUnpaid);
    await expect(
      handed.sendSolanaTransaction("swap", { setup: true, buysFees: "swap" }),
    ).rejects.toThrow(FeesUnpaid);
    expect(wallets.signed.evm).toEqual([{ chainId: MONAD, txs: purchase }]);
    expect(wallets.signed.solana).toEqual([]);
  });

  it("says on a plan what each leg's Allow signs for fees, row by row and in all", async () => {
    // One tap allows every leg of a plan, and each leg's run signs its own deposit (above).
    const leg = { details: (await card()).details! };
    // One line for the whole card, in dollars, naming the service Allow sends to.
    expect(feeCoinsSaid([leg, { details: move.details! }, leg])).toBe(
      "Also buys about $0.50 of ETH for network fees, most of which stays in your wallet. Bought through Relay.",
    );
  });

  it("is weighed in a specialist's pot with the move it serves, so a pot that fits the move alone asks", async () => {
    const shown = await card();
    const leg = {
      direction: "buy" as const,
      effect: { ...shown.effect, gets: [{ text: "a token" }] },
      amountUsd: shown.amountUsd,
      sells: null,
      unpriced: false,
      feesUsd: feeCoinUsd(shown.details!),
    };
    expect(leg.feesUsd).toBe("0.25");
    const pot = (freeCashCents: bigint) =>
      permissionDecision({
        specialist: { actsOnItsOwn: true, freeCashCents, holds: new Map() },
        legs: [leg],
      });
    // $2 for the move and a quarter for the coin: $2.25 fits, a cent less asks.
    expect(pot(225n)).toBe("run");
    expect(pot(224n)).toBe("ask");
    expect(pot(200n)).toBe("ask");
  });

  it("sends the moves of a card that bought none as they are, and no purchase at all", async () => {
    const wallets = recordingWallets();
    const card = { details: { arrivesOn: "Monad" }, txs: [] };
    const handed = await payingFees(
      card,
      async () => wallets,
      async () => {},
    );
    await handed.sendEvmTransaction(ARBITRUM, calls);
    expect(wallets.signed.evm).toEqual([{ chainId: ARBITRUM, txs: calls }]);
    // A send that says it buys the coin is refused where the card showed buying none.
    const purchase = [{ to: DEPOSITORY, data: "0x", setup: true as const, buysFees: "0xorder" }];
    await expect(handed.sendEvmTransaction(MONAD, purchase)).rejects.toThrow(NothingMoved);
    await expect(
      handed.sendSolanaTransaction("swap", { setup: true, buysFees: "swap" }),
    ).rejects.toThrow("its card showed buying none");
    expect(wallets.signed.evm).toHaveLength(1);
    expect(wallets.signed.solana).toEqual([]);
  });
});

describe("whether a card buys the coin", () => {
  it("buys none for a wallet that can pay, or whose fees a sponsor pays there", async () => {
    world.lacks = {};
    expect(await feeCoinFor(move.sends!)).toBeNull();
    world.lacks = { [ARBITRUM]: LACKS };
    world.sponsored.add(ARBITRUM);
    expect(await feeCoinFor(move.sends!)).toBeNull();
  });

  it("buys over what the move is short, and at least a quarter of a dollar, so the next moves there are paid for too", async () => {
    // Short 0.001 ETH, $2 of it: half as much again is bought, for Relay's fee and a moving price.
    world.lacks = { [ARBITRUM]: 10n ** 15n };
    world.usdc[MONAD] = 5_000_000n;
    expect(await feeCoinFor(move.sends!)).toMatchObject({ amount: 3_000_000n, usd: 3 });
  });

  it("pays from the first chain that can send now: one with no coin of its own is passed over", async () => {
    // Polygon holds cash and no POL, as the live wallet did; Base holds both.
    world.coin = { [NETWORKS.base.viem.id]: 10n ** 16n };
    world.usdc = { [NETWORKS.polygon.viem.id]: 5_586_333n, [NETWORKS.base.viem.id]: 2_000_000n };
    expect(await feeCoinFor(move.sends!)).toMatchObject({ from: "base", amount: 250_000n });
  });

  it("never dips into the MON Monad keeps in a delegated wallet", async () => {
    // 15.15 MON to send and 10 kept: 25 is too little, and nothing else can pay.
    world.coin = { [MONAD]: 25n * MON };
    await expect(feeCoinFor(move.sends!)).rejects.toThrow("Too little ETH for gas.");
    world.coin = { [MONAD]: 26n * MON };
    expect(await feeCoinFor(move.sends!)).toMatchObject({ from: "monad", token: "native" });
  });

  it("makes no card where nothing can pay, the fee is past five dollars, or Relay brings too little", async () => {
    const refusal =
      "Too little ETH for gas. Right now the wallet holds none of any chain's own coin for fees.";
    world.coin = {};
    await expect(feeCoinFor(move.sends!)).rejects.toThrow(refusal);
    // Cash alone doesn't make a chain one that can pay: with none of its coin it can send nothing.
    world.usdc[MONAD] = 5_000_000n;
    await expect(feeCoinFor(move.sends!)).rejects.toThrow(refusal);
    world.usdc[MONAD] = 32_221n;
    world.coin = { [MONAD]: 1_000n * MON };
    // Short 0.002 ETH: $4, so $6 with the room a purchase leaves.
    world.lacks = { [ARBITRUM]: 2n * 10n ** 15n };
    await expect(feeCoinFor(move.sends!)).rejects.toThrow("Too little ETH for gas.");
    world.lacks = { [ARBITRUM]: LACKS };
    world.now = (answer) => {
      (answer as Recorded).details.currencyOut.minimumAmount = "1";
      return answer;
    };
    await expect(feeCoinFor(move.sends!)).rejects.toThrow("Too little ETH for gas.");
  });
});

describe("what a card says of the coin it buys", () => {
  it("says what it comes to, that most of it stays, and the service it goes through", async () => {
    const shown = await card();
    expect(feeCoinsSaid([{ details: shown.details! }])).toBe(
      "Also buys about $0.25 of ETH for network fees, most of which stays in your wallet. Bought through Relay.",
    );
  });

  it("says nothing on a card that buys none", () => {
    expect(feeCoinsSaid([{ details: {} }])).toBeNull();
    expect(feeCoinsSaid([{ details: move.details! }])).toBeNull();
  });
});
