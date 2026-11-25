import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Get a pairing code from the CLI when the demo only serves its API. */
export async function demoPairCode(scratch: string, port: number): Promise<string> {
  const auni = fileURLToPath(new URL("../../bin/auni.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [auni, "pair"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AUNI_HOME: join(scratch, `auni-demo-${userInfo().uid}-${port}`),
      WEB_PORT: String(port),
    },
  });
  return /#pair=(\S+)/u.exec(stdout)![1]!;
}
