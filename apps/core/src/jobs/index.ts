import { briefJob } from "../automations/brief.ts";
import { automationRenewJob } from "../automations/renew.ts";
import { sourcesJob } from "../automations/sources.ts";
import { triageJob } from "../automations/triage.ts";
import { channelsJob, deliverJob } from "../channels/hub.ts";
import { startingPointsJob } from "../conversation/starting-points.ts";
import { apps } from "../apps/registry.ts";
import { foundJob } from "../money/news.ts";
import { actionJob, landingJob, proposalJob, reconcileJob, staleCardsJob } from "./action.ts";
import { sweepJob } from "./sweep.ts";
import { pruneJob } from "./prune.ts";
import type { Job } from "./queue.ts";
import { readingBackstopJob, readingJob } from "./readings.ts";
import { signalsJob } from "./signals.ts";
import { statementsJob } from "./statements.ts";
import { turnJob } from "./turn.ts";

// Every kind of job core runs, then each app's own, imported only by what starts the runner:
// code that queues a job imports its kind from kinds.ts, never the code the job runs.
export const jobs: readonly Job<unknown>[] = [
  turnJob,
  actionJob,
  landingJob,
  proposalJob,
  reconcileJob,
  staleCardsJob,
  readingJob,
  readingBackstopJob,
  statementsJob,
  foundJob,
  sweepJob,
  automationRenewJob,
  sourcesJob,
  triageJob,
  briefJob,
  channelsJob,
  deliverJob,
  startingPointsJob,
  signalsJob,
  pruneJob,
  ...apps().flatMap((app) => app.jobs ?? []),
];
