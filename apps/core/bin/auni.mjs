#!/usr/bin/env node
// The `auni` command. Core runs as TypeScript on Node itself, which strips the types as it
// loads each file, one way everywhere (src/cli.ts).
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

// Node tries a host's addresses one at a time and gives each 250ms to connect before the next.
// From a machine far from a service (Telegram's IPv4 takes 270ms from Australia) with no IPv6,
// that gave up on the IPv4 address that would have worked, then failed at once on IPv6, so the
// service "couldn't be reached". A second each; the web app is started with the same (web-app.ts).
setDefaultAutoSelectFamilyAttemptTimeout(1_000);

await import("../src/cli.ts");
