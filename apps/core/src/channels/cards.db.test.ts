import { beforeEach, describe, expect, it } from "vitest";

import { env } from "../env.ts";
import { insertThread, wipe } from "../test/db.ts";
import { threadLink } from "./cards.ts";

// The web's route this must match: apps/web/lib/app-links.ts (chatHref).
describe("threadLink", () => {
  beforeEach(() => wipe());

  it("opens every thread on its chat page", async () => {
    const chat = await insertThread();
    expect(await threadLink(chat.id)).toBe(`${env.WEB_ORIGIN}/app/chat/${chat.id}`);
  });
});
