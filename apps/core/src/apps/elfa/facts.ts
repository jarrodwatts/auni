import { startFrom, type AppFact, type OwnerSeen } from "../contract.ts";
import {
  daysAgo,
  elfaReadable,
  findEvents,
  oncePerStory,
  resolveEntity,
  type ElfaEvent,
} from "./v3.ts";

// The latest news on what the owner holds, as Elfa writes it up from posts on X and Telegram. It
// needs Elfa's key; without one there is no news to tell.

/** Their largest holdings asked about, which keeps the reads well inside the key's budget. */
const HOLDINGS_READ = 3;
const NEWS_DAYS = 2;

export async function newsFacts(seen: OwnerSeen): Promise<AppFact[]> {
  if (!elfaReadable()) return [];
  const each = await Promise.all(
    seen.holdings.slice(0, HOLDINGS_READ).map(async ({ symbol, image }) => {
      const entity = await resolveEntity(symbol, ["token", "equity"]);
      if (!entity) return [];
      const events = await findEvents({
        entityIds: entity.id,
        from: daysAgo(NEWS_DAYS),
        limit: 10,
      });
      const story = oncePerStory(events).find((event) => event.alertTitle);
      return story ? [newsFact(symbol, image, story)] : [];
    }),
  );
  return each.flat();
}

/** News on a holding, wearing the holding's own logo. */
function newsFact(symbol: string, image: string | null, story: ElfaEvent): AppFact {
  const title = story.alertTitle!;
  return {
    text: `News on ${symbol}, which the owner holds, written up from posts on X and Telegram: "${title}".`,
    label: title,
    link: story.citedSources.find((source) => source.link)?.link ?? null,
    image,
    starts: startFrom(
      `There's news on ${symbol}, which I hold: "${title}". What does it mean for my position?`,
      [
        { statement: `News on your ${symbol}.`, action: "What next?" },
        { statement: "News on what you hold.", action: "What next?" },
      ],
    ),
  };
}
