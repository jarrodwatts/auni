import {
  FUNDING_FROM,
  fundingQuoteRequestSchema,
  NETWORKS,
  START_MON,
  type FundingQuoteWire,
  type FundingStatusWire,
} from "@auni/shared";
import express, { Router } from "express";
import { getAddress, parseEther, type Address } from "viem";

import { publicClient } from "../money/chains.ts";
import { payInQuote, PayInRefused, payInStanding } from "../money/pay-in.ts";
import { formatUnits, parseUnits } from "../money/usd.ts";
import { walletAddresses } from "../money/wallets.ts";

/**
 * Add money's "pay from a browser wallet": a quote from USDC on another chain to USDC on
 * Monad, paid to the wallet's own address, which the browser wallet then sends step by step
 * itself. Core asks the pay-in app for it, as the web's own policy lets it reach only core, and
 * holds the quote to what was asked (money/pay-in.ts). No card: nothing here moves Auni's money,
 * and the browser wallet asks its owner before each send.
 */
export const fundingRouter = Router();
fundingRouter.use(express.json({ limit: "4kb" }));

/** Under what Add money asks for, a dollar of the payment comes as MON, for the wallet's network fees. */
const ENOUGH_MON = parseEther(String(START_MON));
const TOP_UP_USD = 1;

fundingRouter.post("/quote", async (req, res) => {
  // Strict: a recipient sent along is refused, never used.
  const body = fundingQuoteRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid_body" });
  const from = FUNDING_FROM.find((key) => NETWORKS[key].viem.id === body.data.chainId);
  const token = from && NETWORKS[from].usdc;
  if (!token) return void res.status(400).json({ error: "chain_not_offered" });
  const amount = parseUnits(body.data.amountUsdc, 6);
  if (amount === 0n) return void res.status(400).json({ error: "invalid_body" });
  const { evm } = await walletAddresses();
  if (!evm) return void res.status(409).json({ error: "no_evm_wallet" });

  // A balance that can't be read now brings no top-up: the payment arrives whole, as USDC.
  const mon = await publicClient("monad")
    .getBalance({ address: evm as Address })
    .catch(() => null);
  try {
    const quote = await payInQuote({
      user: getAddress(body.data.user),
      recipient: evm,
      from: { chain: from, token: getAddress(token) },
      to: { chain: "monad", token: NETWORKS.monad.usdc },
      amount,
      ...(mon !== null && mon < ENOUGH_MON ? { topUpUsd: TOP_UP_USD } : {}),
    });
    res.json({
      by: quote.by,
      requestId: quote.requestId,
      steps: quote.steps.map(({ id, description, call }) => ({
        id,
        description,
        chainId: call.chainId,
        to: call.to,
        data: call.data,
      })),
      receiveUsdc: formatUnits(quote.out, 6),
      receiveMon: quote.gas === null ? null : formatUnits(quote.gas, 18),
      seconds: quote.seconds,
    } satisfies FundingQuoteWire);
  } catch (error) {
    if (!(error instanceof PayInRefused)) throw error;
    res.status(502).json({ error: "quote_refused", message: error.message });
  }
});

fundingRouter.get("/status/:requestId", async (req, res) => {
  const { requestId } = req.params;
  if (!/^0x[0-9a-fA-F]{64}$/u.test(requestId))
    return void res.status(400).json({ error: "invalid_request_id" });
  try {
    const { status } = await payInStanding(requestId as `0x${string}`);
    res.json({ status } satisfies FundingStatusWire);
  } catch (error) {
    if (!(error instanceof PayInRefused)) throw error;
    res.status(502).json({ error: "quote_refused", message: error.message });
  }
});
