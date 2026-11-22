import { signalsKind } from "./kinds.ts";
import { defineJob } from "./queue.ts";
import { refreshOwnerSignals } from "../signals.ts";

/** Refreshes the owner's external personalization signals (X handle, watched wallets) and starting points. */
export const signalsJob = defineJob({
  kind: signalsKind,
  retries: 1,
  async run(data) {
    await refreshOwnerSignals({ replaceSummary: data.replaceSummary });
  },
  async cutShort(_data, _job, why) {
    if (why === "crashed") return "rerun";
  },
});
