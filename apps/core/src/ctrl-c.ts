/**
 * A terminal sends Ctrl-C to the whole process group, and pnpm can relay it too.
 * Only an interrupt at least a second after the first counts as another press.
 */
export function ctrlCHandler(
  stop: () => void,
  force: () => void = () => process.exit(130),
): () => void {
  let firstInterrupt: number | undefined;
  return () => {
    const now = performance.now();
    if (firstInterrupt === undefined) {
      firstInterrupt = now;
      stop();
    } else if (now - firstInterrupt >= 1_000) force();
  };
}
