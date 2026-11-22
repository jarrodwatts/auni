import { parentPort, workerData } from "node:worker_threads";

import type { ColorMode } from "./scene.ts";
import { FRAME_MS, Stage, type StageEvent, type StageSignal } from "./stage.ts";
import { toTerminal } from "./terminal.ts";

// The stage, played on a thread of its own (telling.ts starts it), so Auni never freezes in the
// terminal while its own thread is busy: loading the rest of core takes a second or two of it
// as `auni` starts. Frames go straight to the terminal's file, not through the main thread. Once
// the scene has ended it still listens, without a clock, for a brain found later (its stone fills
// in place), until it's cleared: the terminal is then the owner's.

/** What telling.ts starts this with. */
export interface StageStart {
  readonly color: ColorMode;
  readonly columns: number;
  /** Set to 1, and woken, once the scene is cleared off the terminal (`clear` below). */
  readonly cleared: Int32Array;
}

/** A message from telling.ts: something that happened, or clear the scene off the terminal now. */
export type ToStage = StageEvent | { readonly kind: "clear" };

const { color, columns, cleared } = workerData as StageStart;
const port = parentPort!;
// A terminal that can't take more just now says so; wait a moment and write the rest.
const pause = new Int32Array(new SharedArrayBuffer(4));
/** The terminal is gone, its window closed: nothing more is drawn. */
let gone = false;
function write(text: string): void {
  let bytes = Buffer.from(text);
  while (bytes.length > 0 && !gone) {
    try {
      const wrote = toTerminal(bytes);
      if (wrote === false) gone = true;
      else bytes = bytes.subarray(wrote);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

write("\u001B[?25l");
const stage = new Stage({
  color,
  columns,
  now: Date.now(),
  write,
  signal: (signal: StageSignal) => {
    port.postMessage(signal);
    if (signal === "ended") rest();
  },
});
const timer = setInterval(() => stage.tick(Date.now()), FRAME_MS);

/** The scene is still: no more frames, and the cursor back. */
function rest(): void {
  clearInterval(timer);
  write("\u001B[?25h");
}

port.on("message", (message: ToStage) => {
  if (message.kind !== "clear") {
    stage.hear(message, Date.now());
    return;
  }
  stage.clear();
  rest();
  port.close();
  Atomics.store(cleared, 0, 1);
  Atomics.notify(cleared, 0);
});
