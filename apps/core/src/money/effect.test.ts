import { describe, expect, it } from "vitest";

import {
  approval,
  costsLabel,
  costsTogether,
  stepUpReason,
  effectLines,
  stepUpWhy,
  pinnedApproval,
  type Effect,
  type Grant,
} from "./effect.ts";

const KNOWN = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OTHER = "0x5B7a3f0E2C9d41A8b6e0F7C2d9A4B1E3f6c8D0a2";

const swap: Effect = {
  gives: [{ text: "$40.00 of USDC" }],
  gets: [{ text: "about 0.01 WETH", usd: 39.6 }],
  grants: [],
};
const withdrawal = (to: string): Effect => ({
  gives: [{ text: "$50.00 of USDC" }],
  gets: [],
  grants: [],
  to: [to],
});
const spends: Grant = {
  lets: "0x1a2b…9f8e spend your USDC",
  reach: "wallet",
  exact: { kind: "spend", token: "0x1", to: "0x2" },
};

describe("approval", () => {
  it("is a tap for a trade whose gets land where Auni sees them", () => {
    expect(approval(swap, [])).toEqual({ kind: "tap" });
    const bridge = { ...swap, gets: [{ text: "$39.80", lands: "on Ethereum in about a minute" }] };
    expect(approval(bridge, [])).toEqual({ kind: "tap" });
  });

  it("takes the owner's proof for money leaving to somewhere the owner never sent to, in any case", () => {
    expect(approval(withdrawal(OTHER), [KNOWN])).toEqual({
      kind: "proof",
      reason: "sends money to 0x5B7a…D0a2, where you've never sent before",
    });
    expect(approval(withdrawal(KNOWN.toLowerCase()), [KNOWN])).toEqual({ kind: "tap" });
  });

  it("takes the owner's proof for money leaving where Auni can't say, however often it was sent before", () => {
    const away = { ...swap, gets: [] };
    expect(approval(away, [KNOWN]).kind).toBe("proof");
  });

  it("takes the owner's proof for a lasting power over the main wallet, but not one over a venue wallet", () => {
    expect(approval({ ...swap, grants: [spends] }, [])).toEqual({
      kind: "proof",
      reason: "lets 0x1a2b…9f8e spend your USDC",
    });
    const venue: Grant = { lets: "Polymarket trade your Polymarket cash", reach: "venue" };
    expect(approval({ ...swap, grants: [venue] }, [])).toEqual({ kind: "tap" });
  });

  it("takes the owner's proof for anything a tap can't vouch for", () => {
    expect(approval({ ...swap, blind: "can't be simulated" }, [])).toEqual({
      kind: "proof",
      reason: "can't be simulated",
    });
  });
});

// A tap is judged later by what its card pinned, against where money has gone by then.
describe("stepUpReason", () => {
  it("weighs a pinned destination against what's known when asked", () => {
    const pinned = pinnedApproval(withdrawal(OTHER));
    expect(stepUpReason(pinned, [])).not.toBeNull();
    expect(stepUpReason(pinned, [OTHER])).toBeNull();
  });

  it("lets money leaving for a known address through, in any case", () => {
    expect(stepUpReason({ leavesTo: KNOWN }, [KNOWN])).toBeNull();
    expect(stepUpReason({ leavesTo: KNOWN.toLowerCase() }, [KNOWN])).toBeNull();
    expect(stepUpReason({ leavesTo: `${KNOWN},${OTHER}` }, [KNOWN])).toBe(
      "sends money to 0x5B7a…D0a2, where you've never sent before",
    );
  });

  it("asks for a reason its card pinned, wherever the money goes", () => {
    const pinned = pinnedApproval({ ...withdrawal(KNOWN), grants: [spends], blind: "it's blind" });
    expect(pinned.needsStepUp).toBe("lets 0x1a2b…9f8e spend your USDC; it's blind");
    expect(stepUpReason(pinned, [KNOWN])).toBe(pinned.needsStepUp);
  });

  // Every reason is kept, so a raw transaction's fresh effect may add none the card didn't.
  it("names somewhere new beside any other reason", () => {
    const pinned = pinnedApproval({ ...withdrawal(OTHER), blind: "it's blind" });
    expect(stepUpReason(pinned, [])).toBe(
      "it's blind; sends money to 0x5B7a…D0a2, where you've never sent before",
    );
  });

  it("never asks for a move that sends nothing away", () => {
    expect(stepUpReason(pinnedApproval(swap), [])).toBeNull();
    expect(pinnedApproval(swap)).toEqual({});
  });
});

// The card says one reason, in the owner's words; stepUpReason keeps every one for the agent.
describe("stepUpWhy", () => {
  const SO = ", so Auni checks it's you.";

  it("says nothing where a tap will do", () => {
    expect(stepUpWhy(pinnedApproval(swap), [])).toBeNull();
    expect(stepUpWhy(pinnedApproval(withdrawal(KNOWN)), [KNOWN])).toBeNull();
  });

  it("says money leaving for somewhere new first, or for nowhere Auni can name", () => {
    const pinned = pinnedApproval({ ...withdrawal(OTHER), grants: [spends], blind: "it's blind" });
    expect(stepUpWhy(pinned, [KNOWN])).toBe(
      `It goes to an address you've never sent to before${SO}`,
    );
    expect(stepUpWhy(pinnedApproval({ ...withdrawal(OTHER), to: [] }), [])).toBe(
      `Nothing comes back for what you send, and Auni can't say where it goes${SO}`,
    );
  });

  it("then a permission left over the wallet, then what a tap can't see", () => {
    const leaves = pinnedApproval({ ...swap, grants: [spends], blind: "it's blind" });
    expect(stepUpWhy(leaves, [])).toBe(`It leaves a permission over your wallet behind${SO}`);
    expect(stepUpWhy(pinnedApproval({ ...swap, blind: "it's blind" }), [])).toBe(
      `Auni can't see everything it does by running it first${SO}`,
    );
  });
});

describe("costsTogether", () => {
  it("sums each kind of cost across several moves, so a plan says what it costs in all", () => {
    const withdraw: Effect = { ...swap, costs: [{ label: "Hyperliquid fee", usd: 1 }] };
    const bridge: Effect = { ...swap, costs: [{ label: "network fee", usd: 0.25 }] };
    const both = costsTogether([
      withdraw,
      bridge,
      { ...bridge, costs: [{ label: "network fee", usd: 0.5 }] },
    ]);
    expect(both).toEqual([
      { label: "Hyperliquid fee", usd: 1 },
      { label: "network fee", usd: 0.75 },
    ]);
    expect(costsLabel(both)).toBe("$1.75 ($1 Hyperliquid fee, $0.75 network fee)");
    expect(costsTogether([swap])).toEqual([]);
  });
});

describe("effectLines", () => {
  it("says what goes, what comes back and where, what it costs, and what it lets", () => {
    const effect: Effect = {
      gives: [{ text: "0.01 WETH", usd: 40 }],
      gets: [{ text: "about $39.60", lands: "on Ethereum in about a minute" }],
      grants: [{ lets: "Polymarket collect your winnings", reach: "venue" }],
      costs: [
        { label: "network fee", usd: 0.2 },
        { label: "price move", usd: 0.004 },
      ],
    };
    expect(effectLines(effect)).toEqual([
      { label: "You give", value: "0.01 WETH ($40)" },
      { label: "You get", value: "about $39.60 on Ethereum in about a minute" },
      { label: "Costs", value: "$0.20 ($0.20 network fee, under $0.01 price move)" },
      { label: "Lets", value: "Polymarket collect your winnings" },
    ]);
  });

  it("says money leaving with nothing back as a send, to the whole address it goes to", () => {
    expect(effectLines(withdrawal(OTHER))).toEqual([
      { label: "You send", value: "$50.00 of USDC" },
      { label: "To", value: OTHER },
    ]);
  });

  it("says nothing comes back where Auni can't name where money goes", () => {
    expect(effectLines({ ...withdrawal(OTHER), to: [] })).toEqual([
      { label: "You send", value: "$50.00 of USDC" },
      { label: "You get", value: "Nothing back" },
    ]);
  });

  it("says nothing of what doesn't move", () => {
    expect(effectLines({ gives: [], gets: [], grants: [] })).toEqual([]);
  });
});
