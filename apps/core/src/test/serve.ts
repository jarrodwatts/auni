import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Express } from "express";
import { afterAll, beforeAll } from "vitest";

/** Serves an app on a free local port for the test file; the returned function builds its URLs. */
export function serve(app: Express): (path?: string) => string {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = app.listen(0);
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));
  return (path = "") => `${base}${path}`;
}
