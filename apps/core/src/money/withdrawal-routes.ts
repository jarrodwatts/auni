import {
  WITHDRAW_NETWORKS,
  type withdrawalWireSchema,
  type withdrawCashWireSchema,
  type WithdrawNetwork,
} from "@auni/shared";
import express, { Router, type Response } from "express";
import { parseUnits } from "viem";
import { z } from "zod";

import { appById } from "../apps/registry.ts";
import type { ActionRow } from "../db/schema.ts";
import { actionById, actionWire, proposeAction } from "./actions.ts";
import { worthUsd } from "./books.ts";
import { portfolioNow } from "./portfolio.ts";
import type { FundingChain } from "./recipe.ts";
import { withdrawUsdc } from "./recipes/withdraw.ts";
import { needsStepUp } from "./step-up.ts";
import {
  lookalikeOf,
  maxWithdrawal,
  pastDestinations,
  recentWithdrawals,
  usdcToUsd,
  WITHDRAW_TOOL,
} from "./withdrawals.ts";

/**
 * Withdraw: the cash it can send and where it went lately, the proposal (recorded like any
 * action the agent proposes, so the same Allow runs it), what the confirm step
 * must show, and whether a new address takes the owner's proof.
 */
export const withdrawalsRouter = Router();
withdrawalsRouter.use(express.json({ limit: "4kb" }));

/**
 * The cash the portfolio's Cash shows, read as it reads it (see portfolioNow), so the two say
 * one thing: the USDC in the owner's own wallet, which a withdrawal sends, and the cash kept at
 * each app, which comes home by that app's own move first.
 */
withdrawalsRouter.get("/cash", async (_req, res) => {
  const [{ cash }, recent] = await Promise.all([portfolioNow(), recentWithdrawals()]);
  const inWallet = cash.holdings.filter(({ venue }) => venue === "wallet");
  const balances = new Map(
    inWallet.map(({ chain, quantity, decimals }) => [
      chain as FundingChain,
      parseUnits(quantity, decimals),
    ]),
  );
  const elsewhere = [
    ...Map.groupBy(
      cash.holdings.filter(({ venue }) => venue !== "wallet"),
      ({ venue }) => venue,
    ),
  ]
    .map(([venue, held]) => ({
      name: appById(venue)?.about.name ?? venue,
      usdValue: worthUsd(held),
    }))
    .filter(({ usdValue }) => Number(usdValue) > 0)
    .toSorted((a, b) => Number(b.usdValue) - Number(a.usdValue));
  res.json({
    cashUsd: cash.usdValue,
    walletUsd: worthUsd(inWallet),
    elsewhere,
    // The most one withdrawal can send to each network.
    maxUsd: Object.fromEntries(
      WITHDRAW_NETWORKS.map((network) => [network, usdcToUsd(maxWithdrawal(network, balances))]),
    ) as Record<WithdrawNetwork, string>,
    recent: recent.map((place) => ({ ...place, at: place.at.toISOString() })),
  } satisfies z.input<typeof withdrawCashWireSchema>);
});

/** The action, and what the confirm step shows beside it: the full address and whether it's new or a lookalike. */
async function withdrawalWire(row: ActionRow): Promise<z.input<typeof withdrawalWireSchema>> {
  const input = z.object(withdrawUsdc.input).parse(row.input);
  const destination = row.details.leavesTo ?? "";
  const past = await pastDestinations();
  return {
    action: actionWire(row),
    review: {
      address: destination,
      network: input.network,
      destination: input.destination ?? null,
      newAddress: await needsStepUp(row),
      lookalike: lookalikeOf(destination, past),
    },
  };
}

withdrawalsRouter.post("/", async (req, res) => {
  try {
    const outcome = await proposeAction({ threadId: null }, withdrawUsdc, req.body);
    res.json(await withdrawalWire(outcome.action));
  } catch (error) {
    res.status(400).json({
      error: "withdrawal_refused",
      message:
        error instanceof z.ZodError
          ? "Check the amount and the address."
          : error instanceof Error
            ? error.message
            : "That withdrawal can't go ahead.",
    });
  }
});

async function ownWithdrawal(id: unknown, res: Response) {
  const parsed = z.uuid().safeParse(id);
  const row = parsed.success ? await actionById(parsed.data) : null;
  if (row?.tool === WITHDRAW_TOOL) return row;
  res.status(404).json({ error: "withdrawal_not_found" });
  return null;
}

withdrawalsRouter.get("/:id", async (req, res) => {
  const row = await ownWithdrawal(req.params.id, res);
  if (row) res.json(await withdrawalWire(row));
});
