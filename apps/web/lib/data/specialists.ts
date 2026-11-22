import {
  specialistWireSchema,
  valueHistoryWireSchema,
  type SpecialistId,
  type SpecialistWire,
  type HoldingWire,
  type ValueRange,
} from "@auni/shared";
import { z } from "zod";

import { requestCore } from "@/lib/core";

import { dollarsToBaseUnits, usdc } from "./usdc";
import type { Specialist, Holding, ValueHistory } from "./views";

/**
 * Specialists: what the person believes, what Auni holds for it, and how it is
 * going, live from core's /specialists.
 */

/** Core's holding in the base units the screens read. */
export function toHolding({ usdValue, todayChangeUsd, ...face }: HoldingWire): Holding {
  return {
    ...face,
    value: usdc(dollarsToBaseUnits(usdValue)),
    todayChangeBaseUnits:
      todayChangeUsd === null ? null : dollarsToBaseUnits(todayChangeUsd).toString(),
  };
}

export function toSpecialist(core: SpecialistWire): Specialist {
  return {
    id: core.id,
    kind: core.kind,
    name: core.name,
    purpose: core.purpose,
    notes: core.notes,
    report: core.report,
    // The orb's colour and shape come from the id; its glyph from the theme the agent picked.
    theme: core.theme ?? "default",
    pulse: core.pulse,
    status: core.status,
    rules: core.rules,
    potUsd: core.potUsd,
    startedAt: core.createdAt,
    retiredAt: core.retiredAt,
    value: usdc(dollarsToBaseUnits(core.valueUsd)),
    made: usdc(dollarsToBaseUnits(core.madeUsd)),
    todayChangeBaseUnits: dollarsToBaseUnits(core.todayChangeUsd).toString(),
    holdings: core.holdings.map(toHolding),
    startedIn: core.startedIn,
  };
}

function get(path: string, signal?: AbortSignal) {
  return requestCore(path, { method: "GET", signal });
}

export async function listSpecialists(signal?: AbortSignal): Promise<readonly Specialist[]> {
  const body = z
    .object({ specialists: z.array(specialistWireSchema) })
    .parse(await get("specialists", signal));
  return body.specialists.map(toSpecialist);
}

/** One specialist with its record of what Auni did; closed ones still answer. */
export async function getSpecialist(
  specialistId: SpecialistId,
  signal?: AbortSignal,
): Promise<Specialist> {
  const body = z
    .object({ specialist: specialistWireSchema })
    .parse(await get(`specialists/${specialistId}`, signal));
  return toSpecialist(body.specialist);
}

/**
 * The account (no specialist) or one specialist over a range, as the charts
 * draw it, from core's GET /portfolio/history or GET /specialists/:id/history.
 */
export async function getValueHistory(
  specialistId: SpecialistId | null,
  range: ValueRange,
  signal?: AbortSignal,
): Promise<ValueHistory> {
  const path = specialistId ? `specialists/${specialistId}/history` : "portfolio/history";
  const body = valueHistoryWireSchema.parse(await get(`${path}?range=${range}`, signal));
  return {
    startedAt: body.startedAt,
    points: body.points.map((point) => ({
      observedAt: point.takenAt,
      totalUsd: usdc(dollarsToBaseUnits(point.usdValue)),
      made: usdc(dollarsToBaseUnits(point.madeUsd)),
    })),
  };
}
