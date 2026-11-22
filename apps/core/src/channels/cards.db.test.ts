import { beforeEach, describe, expect, it } from "vitest";

import { env } from "../env.ts";
import { insertSpecialist, insertThread, wipe } from "../test/db.ts";
import { threadLink } from "./cards.ts";

// The web's routes these must match: apps/web/lib/app-links.ts (specialistHref, chatHref).
describe("threadLink", () => {
  beforeEach(() => wipe());

  it("opens a specialist's thread on its page, and a chat on its own", async () => {
    const specialist = await insertSpecialist();
    const own = await insertThread({ specialistId: specialist.id });
    const chat = await insertThread();
    expect(await threadLink(own.id)).toBe(`${env.WEB_ORIGIN}/app/s/${specialist.id}`);
    expect(await threadLink(chat.id)).toBe(`${env.WEB_ORIGIN}/app/chat/${chat.id}`);
  });
});
