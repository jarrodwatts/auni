import { describe, expect, it } from "vitest";

import {
  askAbout,
  failedStep,
  needingYou,
  needsYouLabel,
  onlyWhileNewest,
  placedActions,
  retryProblem,
  type Failure,
  reportable,
} from "./failed-step";

const failure = (changes: Partial<Failure> = {}): Failure => ({
  kind: "glitch",
  said: null,
  where: "Your money is still in your Monad wallet.",
  retryable: true,
  ...changes,
});

describe("failedStep", () => {
  it("offers Try again after a blip, a busy venue or anything unknown, saying where the money is", () => {
    expect(failedStep(failure(), null, true)).toEqual({
      reason: "A network blip stopped it. Your money is still in your Monad wallet.",
      actions: ["retry", "ask"],
    });
    expect(failedStep(failure({ kind: "busy" }), null, true).reason).toBe(
      "The venue was busy. Your money is still in your Monad wallet.",
    );
    expect(failedStep(failure({ kind: null, said: "Quote expired." }), null, true)).toEqual({
      reason: "Quote expired. Your money is still in your Monad wallet.",
      actions: ["retry", "ask"],
    });
  });

  it("says why in core's own sentence where it gave one, for money that wasn't there and a busy venue too", () => {
    const short = "There isn't enough free cash in your account for this, so nothing was opened.";
    expect(failedStep(failure({ kind: "funds", said: short }), null, true)).toEqual({
      reason: `${short} Your money is still in your Monad wallet.`,
      actions: ["add_money", "ask"],
    });
    const quiet = "Nobody is offering to trade this market right now.";
    expect(failedStep(failure({ kind: "busy", said: quiet }), null, true)).toEqual({
      reason: `${quiet} Your money is still in your Monad wallet.`,
      actions: ["retry", "ask"],
    });
  });

  it("offers Add money when there wasn't enough, and never a Try again that would fail the same way", () => {
    expect(failedStep(failure({ kind: "funds" }), null, true)).toEqual({
      reason: "There wasn't enough money for it. Your money is still in your Monad wallet.",
      actions: ["add_money", "ask"],
    });
    expect(failedStep(failure({ kind: "rule", said: "Minimum is $10." }), null, true)).toEqual({
      reason: "Minimum is $10. Your money is still in your Monad wallet.",
      actions: ["ask"],
    });
  });

  // Nothing moved, but its sends stay on its record, so a fresh card trades it again.
  it("says no one filled an unfilled order, and offers asking Auni rather than Try again", () => {
    const said = "No one filled the order on Monad, so nothing was traded.";
    expect(failedStep(failure({ kind: "unfilled", said, retryable: false }), null, true)).toEqual({
      reason: `${said} Your money is still in your Monad wallet.`,
      actions: ["ask"],
    });
  });

  it("runs a moved price again only once a fresh quote is back inside what was approved", () => {
    const price = failure({ kind: "price" });
    expect(failedStep(price, { inside: true, price: "$184.20" }, true)).toEqual({
      reason:
        "The price moved, and it's back inside what you approved. Your money is still in your Monad wallet.",
      actions: ["retry", "ask"],
    });
    expect(failedStep(price, { inside: false, price: "$190.10" }, true)).toEqual({
      reason:
        "The price moved past what you approved, to $190.10. Your money is still in your Monad wallet.",
      actions: ["ask"],
    });
    // Until the quote is read, nothing claims it would go through.
    expect(failedStep(price, null, true).actions).toEqual(["ask"]);
  });

  it("never offers to send again what went out, or may have", () => {
    expect(failedStep(failure({ kind: "sent" }), null, true)).toEqual({
      reason:
        "Part of it may have gone out, so Auni won't send it again. Ask Auni where your money is.",
      actions: ["ask"],
    });
  });

  it("says in core's words where the money for a fee purchase went, never that it stayed put", () => {
    const said =
      "Relay has the 15 MON this card sent it from Monad and hasn't paid the ETH yet. It pays or refunds by itself. Try again once the ETH is there: nothing more is bought.";
    expect(failedStep(failure({ kind: "fees", said }), null, true)).toEqual({
      reason: said,
      actions: ["retry", "ask"],
    });
    const unsaid = failedStep(failure({ kind: "fees" }), null, true).reason;
    expect(unsaid).toContain("hasn't arrived");
    expect(unsaid).not.toContain("Your money is still in");
  });

  it("says in core's words where a paused step's cash is, and asks nothing, since Auni puts it up again", () => {
    const said =
      "Paused before sending: its card didn't show a permission it leaves. Its $25 is in your wallet on Polygon. Auni will put it up again fresh.";
    const paused = failedStep(failure({ kind: "unshown", said, retryable: false }), null, true);
    expect(paused).toEqual({ reason: said, actions: [] });
    expect(needingYou([paused])).toBe(0);
    expect(reportable("unshown")).toBe(false);
  });

  it("drops Try again for money leaving the person, and Ask Auni where Auni can't be asked", () => {
    expect(failedStep(failure({ retryable: false }), null, true).actions).toEqual(["ask"]);
    expect(failedStep(failure(), null, false).actions).toEqual(["retry"]);
    expect(failedStep(failure({ kind: "sent" }), null, false).actions).toEqual([]);
  });
});

describe("a held step", () => {
  const why = "Auni sent it and never heard back, so it can't tell whether it went through.";
  const held = failure({ kind: "sent", said: why, retryable: false, held: true });

  it("says why and what stays true, and offers to check again or close, never to send again", () => {
    expect(failedStep(held, null, true)).toEqual({
      reason: `${why} Auni won't send it again, and your portfolio shows what you hold either way.`,
      actions: ["check", "close", "ask"],
    });
    expect(failedStep(held, null, false).actions).toEqual(["check", "close"]);
  });

  it("asks once what closing means before it closes, with a way back", () => {
    expect(failedStep(held, null, true, true)).toEqual({
      reason:
        "Close it without a record? Auni stops checking, and adds nothing to any thread's record. Your portfolio still shows what you hold.",
      actions: ["keep", "close"],
    });
  });

  it("keeps its two taps on a card the conversation went on past", () => {
    expect((["check", "close", "keep"] as const).map(onlyWhileNewest)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("asks Auni what happened, not what to do instead", () => {
    expect(askAbout("Not confirmed: Sell 40 Yes shares", why, true)).toBe(
      `"Not confirmed: Sell 40 Yes shares. ${why}" What happened, and where can I look?`,
    );
  });
});

describe("placedActions", () => {
  it("offers each action once, on the first row that has it", () => {
    const blip = failedStep(failure(), null, true);
    const short = failedStep(failure({ kind: "funds" }), null, true);
    expect(
      placedActions([
        ["a", blip],
        ["b", blip],
        ["c", short],
      ]),
    ).toEqual(
      new Map([
        ["a", ["retry", "ask"]],
        ["b", []],
        ["c", ["add_money"]],
      ]),
    );
  });
});

describe("needingYou", () => {
  it("counts the steps that wait on the person", () => {
    const steps = [
      failedStep(failure(), null, true),
      failedStep(failure({ kind: "sent" }), null, false),
      failedStep(failure({ kind: "funds" }), null, false),
    ];
    expect(needingYou(steps)).toBe(2);
    expect(needsYouLabel(1)).toBe("1 needs your OK");
    expect(needsYouLabel(2)).toBe("2 need your OK");
  });
});

describe("retryProblem", () => {
  it("says why a tap didn't run, and nothing when the card already shows it moved on", () => {
    expect(retryProblem("not_failed")).toBeNull();
    expect(retryProblem("short_of_money")).toBe(
      "There isn't enough money there for it now. Nothing moved.",
    );
    expect(retryProblem(null)).toBe("Auni couldn't be reached. Nothing moved, so try again.");
  });
});

describe("askAbout", () => {
  it("asks Auni about the step as its row names it, with why and where the money is", () => {
    expect(askAbout("Didn't buy NVIDIA", "A network blip stopped it.")).toBe(
      '"Didn\'t buy NVIDIA. A network blip stopped it." What can I do instead?',
    );
  });
});

describe("reportable", () => {
  it("offers to report what may be a bug, never a failure that is nobody's fault", () => {
    expect((["unknown", "rule", "unfilled", "sent", null] as const).map(reportable)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(
      (["funds", "price", "busy", "glitch", "stopped", "fees"] as const).map(reportable),
    ).toEqual([false, false, false, false, false, false]);
  });
});

describe("onlyWhileNewest", () => {
  it("keeps Try again on a card the conversation went on past, and only that", () => {
    // A failed move that can still run again keeps its way to, however much was said after it.
    expect(onlyWhileNewest("retry")).toBe(false);
    expect(onlyWhileNewest("ask")).toBe(true);
    expect(onlyWhileNewest("add_money")).toBe(true);
  });
});
