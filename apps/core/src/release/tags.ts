// A release's tag is `v<major>.<minor>.<patch>`, the root package.json's version prefixed: the
// one version number Auni has. Pre-releases (`v0.2.0-rc.1`) are never releases. install.sh
// checks and orders them with the same rule (`is_tag`, and `older` in awk).

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;

/** A release tag's numbers, or null for anything else. */
function numbers(tag: string): [number, number, number] | null {
  const match = TAG.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `tag` is a release tag. */
export const isReleaseTag = (tag: string): boolean => numbers(tag) !== null;

/** Orders release tags oldest first: v0.9.3 before v0.10.0. */
export function byRelease(a: string, b: string): number {
  const [x, y] = [numbers(a), numbers(b)];
  if (!x || !y) throw new Error(`Not a release tag: ${x ? b : a}`);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
