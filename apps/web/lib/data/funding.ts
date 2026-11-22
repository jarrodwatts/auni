import {
  fundingQuoteWireSchema,
  fundingStatusWireSchema,
  type FundingQuoteRequest,
  type FundingQuoteWire,
  type FundingStatusWire,
} from "@auni/shared";

import { requestCore } from "@/lib/core";

/** Paying into Auni from a browser wallet: the quote core checked, and where it stands. */

export async function quoteFunding(request: FundingQuoteRequest): Promise<FundingQuoteWire> {
  return fundingQuoteWireSchema.parse(
    await requestCore("funding/quote", { method: "POST", body: JSON.stringify(request) }),
  );
}

export async function fundingStatus(requestId: string): Promise<FundingStatusWire["status"]> {
  const { status } = fundingStatusWireSchema.parse(
    await requestCore(`funding/status/${requestId}`, { method: "GET" }),
  );
  return status;
}
