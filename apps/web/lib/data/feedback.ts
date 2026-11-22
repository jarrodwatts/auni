import { feedbackWireSchema, type Feedback } from "@auni/shared";

import type { ReportSubject } from "@/lib/app-links";
import { requestCore } from "@/lib/core";

/** What a report the owner starts themselves is about: a move that failed, or an app. */
export type ReportAbout = ReportSubject;

/**
 * What core would post for a report the owner starts themselves (core's `GET /feedback`): built
 * from core's own records, with no brain asked and nothing sent anywhere.
 */
export async function readReport(about: ReportAbout, signal?: AbortSignal): Promise<Feedback> {
  const query = new URLSearchParams(about);
  const body = await requestCore(`feedback?${query}`, {
    method: "GET",
    ...(signal ? { signal } : {}),
  });
  return feedbackWireSchema.parse(body).feedback;
}
