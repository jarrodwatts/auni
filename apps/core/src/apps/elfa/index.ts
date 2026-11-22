import { defineApp } from "../contract.ts";
import { tryKeyAt } from "../../try-key.ts";
import { newsFacts } from "./facts.ts";
import about from "./about.ts";
import { BASE_URL } from "./request.ts";
import { marketTools } from "./tools.ts";
import { elfaReadable } from "./v3.ts";
import { elfaSource } from "./watch.ts";

/**
 * Elfa (elfa.ai): market news, attention and positioning read from posts on X and Telegram,
 * and Elfa Auto, which watches the news, posts and markets for conditions it evaluates itself.
 * It also tells the latest news on what the owner holds.
 */
export default defineApp({
  about,
  // Its market data needs only its key; without one, the agent never sees tools that can't answer.
  lookups: () => (elfaReadable() ? marketTools() : []),
  watches: elfaSource,
  facts: newsFacts,
  // What a key can do, which costs no credit and answers even when credits run out.
  tryKey: (_key, value) =>
    tryKeyAt(`${BASE_URL}/v3/key-status`, { headers: { "x-elfa-api-key": value } }),
});
