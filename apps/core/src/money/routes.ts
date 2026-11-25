import {
  NETWORK_KEYS,
  valueRangeSchema,
  type ActionQuoteWire,
  type ActivityWire,
  type HoldingWire,
  type OtherTokensWire,
  type portfolioWireSchema,
  type proposalWireSchema,
  type valueHistoryWireSchema,
} from "@auni/shared";
import { eq } from "drizzle-orm";
import express, { Router, type Request, type Response } from "express";
import { z } from "zod";

import { theOwner } from "../auth/owner.ts";
import { ownerHere } from "../auth/proof.ts";
import { db } from "../db/client.ts";
import { threads } from "../db/schema.ts";
import { markActivitySeen, readActivity } from "./activity.ts";
import { depositWire, recentDeposits } from "./arrivals.ts";
import { listOtherTokens } from "./buckets.ts";
import { actionById, actionsForThread, actionWire, proposalActions } from "./actions.ts";
import {
  allowAction,
  allowProposal,
  declineAction,
  declineProposal,
  OUT_OF_DATE,
} from "./decide.ts";
import { checkHeld, closeHeld } from "./held.ts";
import { proposalFunding } from "./funding.ts";
import { pickDetail } from "./pick-detail.ts";
import { legsToRetry } from "./proposal-order.ts";
import { quoteAgain, retryAction, retryProposal, type Retried } from "./retry.ts";
import { holdingViews } from "./holdings.ts";
import { madeUsd, unpricedOf, walletFlows } from "./made.ts";
import { addToken, readOtherTokens } from "./other-tokens.ts";
import { portfolioNow } from "./portfolio.ts";
import { plainCashUsd } from "./readings.ts";
import { sweepSoon } from "./sweep.ts";
import { startOfDay, valueHistory } from "./value-history.ts";

const uuid = z.uuid();

export const actionsRouter = Router();
actionsRouter.use(express.json({ limit: "4kb" }));
actionsRouter.get("/", async (req, res) => {
  const threadId = uuid.safeParse(req.query.thread_id);
  if (!threadId.success) {
    res.status(400).json({ error: "thread_id_required" });
    return;
  }
  const rows = await actionsForThread(threadId.data);
  res.json({ actions: rows.map(actionWire) });
});

actionsRouter.get("/:id", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const row = id.success ? await actionById(id.data) : null;
  if (!row) {
    res.status(404).json({ error: "action_not_found" });
    return;
  }
  res.json({ action: actionWire(row) });
});

/** What a pick shows when opened on its card: its line and the numbers for its kind, read live. */
actionsRouter.get("/:id/detail", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const row = id.success ? await actionById(id.data) : null;
  if (!row) {
    res.status(404).json({ error: "action_not_found" });
    return;
  }
  const detail = await pickDetail(row).catch((error: unknown) => {
    console.warn(`pick detail unreadable for ${row.id}`, error);
    return null;
  });
  res.json({ detail });
});

/** A move a tap can't vouch for takes proof the owner is there: the request itself (auth/proof.ts). */
actionsRouter.post("/:id/allow", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return void res.status(404).json({ error: "action_not_found" });
  const allowed = await allowAction(id.data, ownerHere(req));
  switch (allowed.kind) {
    case "refused":
      return void res.status(403).json({ error: allowed.reason });
    case "not_waiting":
      return void (await answerNotWaiting(id.data, res));
    case "in_its_field":
      return void res.status(409).json({ error: "in_its_field" });
    case "out_of_date":
      return void res.status(409).json({ error: "out_of_date", message: OUT_OF_DATE });
    case "allowed":
      return void res.json({ action: actionWire(allowed.action) });
  }
});

actionsRouter.post("/:id/decline", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return void res.status(404).json({ error: "action_not_found" });
  const declined = await declineAction(id.data);
  if (!declined) return void (await answerNotWaiting(id.data, res));
  res.json({ action: actionWire(declined) });
});

/** The run of a failed step the person saw: Try again runs it once, as the next. */
const retryBody = z.object({ attempts: z.number().int().positive() });

actionsRouter.post("/:id/retry", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const body = retryBody.safeParse(req.body ?? {});
  if (!body.success) return void res.status(400).json({ error: "attempts_required" });
  const row = id.success ? await actionById(id.data) : null;
  if (!row) return void res.status(404).json({ error: "action_not_found" });
  const retried = await retryAction(row, body.data.attempts);
  const refusal = retryRefusalCode(retried);
  const now = await actionById(row.id);
  if (!now) return void res.status(404).json({ error: "action_not_found" });
  if (refusal)
    return void res.status(refusal.status).json({ error: refusal.error, action: actionWire(now) });
  res.json({ action: actionWire(now) });
});

/**
 * The owner's two taps on a held move (money/held.ts): Auni reads it again now, or it is closed
 * as it stands. Either answers with the move as it then is; neither sends anything.
 */
for (const [tap, act] of [
  ["check", checkHeld],
  ["close", closeHeld],
] as const)
  actionsRouter.post(`/:id/${tap}`, async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    const row = id.success ? await actionById(id.data) : null;
    if (!row) return void res.status(404).json({ error: "action_not_found" });
    const now = await act(row.id);
    if (!now) return void res.status(409).json({ error: "not_held", action: actionWire(row) });
    res.json({ action: actionWire(now) });
  });

/** A failed step priced again now, against what was approved; read only. */
actionsRouter.get("/:id/quote", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const row = id.success ? await actionById(id.data) : null;
  if (!row) return void res.status(404).json({ error: "action_not_found" });
  if (row.status !== "failed") return void res.status(409).json({ error: "not_failed" });
  const quote = await quoteAgain(row).catch((error: unknown) => {
    console.warn(`quote for ${row.id} unreadable`, error);
    return null;
  });
  if (!quote) return void res.status(503).json({ error: "quote_unavailable" });
  res.json({ quote } satisfies { quote: ActionQuoteWire });
});

/** How a tap on Try again that didn't run answers: why, as the web reads it. */
function retryRefusalCode(retried: Retried): { status: number; error: string } | null {
  switch (retried.kind) {
    case "running":
      return null;
    case "refused":
      return { status: 409, error: retried.reason };
    case "moved_on":
      return { status: 409, error: "not_failed" };
  }
}

async function answerNotWaiting(actionId: string, res: Response): Promise<void> {
  const current = await actionById(actionId);
  if (!current) res.status(404).json({ error: "action_not_found" });
  else res.status(409).json({ error: "not_awaiting_permission", action: actionWire(current) });
}

/**
 * A proposal card's legs, plus what the owner still has to add before
 * the waiting ones can run: read them, or allow or decline every waiting one
 * with one tap.
 */
export const proposalsRouter = Router();
proposalsRouter.use(express.json({ limit: "4kb" }));

async function answerProposal(proposalId: string, req: Request, res: Response): Promise<void> {
  const legs = await proposalActions(proposalId);
  if (legs.length === 0) return void res.status(404).json({ error: "proposal_not_found" });
  // A moved price is weighed when the card quotes it again, so none is left out here.
  const retrying = new Set(legsToRetry(legs, new Set()) ?? []);
  const funding = await proposalFunding(legs);
  res.json({
    // Each leg offers Try again only if a tap on the card would run it (see legsToRetry).
    actions: legs.map((leg) => ({ ...actionWire(leg), retryable: retrying.has(leg.id) })),
    funding,
  } satisfies z.input<typeof proposalWireSchema>);
}

proposalsRouter.get("/:id", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return void res.status(404).json({ error: "proposal_not_found" });
  await answerProposal(id.data, req, res);
});

proposalsRouter.post("/:id/allow", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return void res.status(404).json({ error: "proposal_not_found" });
  if ((await allowProposal(id.data)) === "out_of_date")
    return void res.status(409).json({ error: "out_of_date", message: OUT_OF_DATE });
  await answerProposal(id.data, req, res);
});

proposalsRouter.post("/:id/retry", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return void res.status(404).json({ error: "proposal_not_found" });
  const body = retryBody.safeParse(req.body ?? {});
  if (!body.success) return void res.status(400).json({ error: "attempts_required" });
  const retried = await retryProposal(id.data, body.data.attempts);
  if (!retried) return void res.status(404).json({ error: "proposal_not_found" });
  const refusal = retryRefusalCode(retried);
  if (refusal) return void res.status(refusal.status).json({ error: refusal.error });
  await answerProposal(id.data, req, res);
});

proposalsRouter.post("/:id/decline", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return void res.status(404).json({ error: "proposal_not_found" });
  await declineProposal(id.data);
  await answerProposal(id.data, req, res);
});

export const portfolioRouter = Router();
portfolioRouter.use(express.json({ limit: "4kb" }));

/**
 * The live total and the money outside every specialist (Other and Cash),
 * ready to show. Each ask sweeps the wallets for money that moved, in the
 * background and at most every so often (see sweepSoon), more often with
 * `?deposit=1` from a screen waiting on one; once the sweep records it,
 * portfolioNow reads the venues again and shows it, and it is among the
 * deposits that screen sees land.
 */
portfolioRouter.get("/", async (req, res) => {
  sweepSoon(req.query.deposit === "1");
  // The read first: what it finds already there begins to count as it reads (see first-look.ts).
  const portfolio = await portfolioNow();
  const [flows, deposits, others, { timeZone }] = await Promise.all([
    walletFlows(),
    recentDeposits(),
    // A list that can't be read now hides the row, never the portfolio.
    listOtherTokens().catch((error: unknown) => {
      console.warn("other tokens unreadable:", error);
      return [];
    }),
    theOwner(),
  ]);
  res.json({
    totalUsd: portfolio.totalUsd,
    madeUsd: madeUsd(
      Number(portfolio.totalUsd),
      plainCashUsd(portfolio),
      flows,
      Infinity,
      unpricedOf(portfolio.holdings),
    ),
    unavailable: [...portfolio.unavailable],
    looking: [...portfolio.looking],
    holdings: [
      ...onTheWay(portfolio.onTheWay.usdValue),
      ...(await holdingViews(portfolio.assets.holdings, startOfDay(timeZone))),
    ],
    cashUsd: portfolio.cash.usdValue,
    otherTokens: others.length,
    deposits: deposits.map(depositWire),
  } satisfies z.input<typeof portfolioWireSchema>);
});

/** Their Other tokens as they open the list (see readOtherTokens). */
portfolioRouter.get("/other-tokens", async (req, res) => {
  res.json((await readOtherTokens()) satisfies OtherTokensWire);
});

const addTokenBody = z.object({ network: z.enum(NETWORK_KEYS), address: z.string().max(64) });

/** "Add": one of their Other tokens is theirs, at their word (see addToken). */
portfolioRouter.post("/other-tokens", async (req, res) => {
  const body = addTokenBody.safeParse(req.body ?? {});
  const added = body.success ? await addToken(body.data.network, body.data.address) : null;
  if (!added) return void res.status(400).json({ error: "invalid_token" });
  res.status(204).end();
});

/** Money sent across that hasn't landed: the total counts it, so a line says where it is. */
function onTheWay(usdValue: string): HoldingWire[] {
  if (Number(usdValue) <= 0) return [];
  return [
    {
      id: "on-the-way",
      name: "On the way",
      detail: "Arriving in a few minutes",
      logoUrl: "/brand/tokens/usdc.svg",
      usdValue,
      todayChangeUsd: null,
    },
  ];
}

/** The total over `?range=` (see valueRangeSchema). */
portfolioRouter.get("/history", async (req, res) => {
  const range = valueRangeSchema.safeParse(req.query.range);
  if (!range.success) return void res.status(400).json({ error: "invalid_range" });
  res.json((await valueHistory(range.data)) satisfies z.input<typeof valueHistoryWireSchema>);
});

/**
 * What happened to their money, newest first, everything or with
 * `?thread=<id>` one thread's, and how many of all of it are unread.
 */
export const activityRouter = Router();

activityRouter.get("/", async (req, res) => {
  const thread = req.query.thread === undefined ? null : uuid.safeParse(req.query.thread);
  if (thread) {
    if (!thread.success) return void res.status(404).json({ error: "thread_not_found" });
    const [exists] = await db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.id, thread.data));
    if (!exists) return void res.status(404).json({ error: "thread_not_found" });
  }
  res.json((await readActivity(thread?.data ?? null)) satisfies ActivityWire);
});

/** They looked: everything recorded so far is read. */
activityRouter.post("/seen", async (req, res) => {
  await markActivitySeen();
  res.status(204).end();
});
