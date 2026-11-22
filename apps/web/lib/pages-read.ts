import { getToolName, isToolUIPart } from "ai";

import type { AuniUiMessage } from "./conversation";
import { stepSites } from "./sources";
import { candidatesFound, picksNamed, picksProposed, type PickWeighed } from "./tool-results";

/** A page on the pile a chat's first answer reads from: a site it read, or a pick it weighed. */
export type ReadPage =
  { readonly kind: "site"; readonly site: string } | ({ readonly kind: "pick" } & PickWeighed);

/**
 * Every page a turn has read so far, each once, in the order it read them: the sites its web
 * steps read, and the picks its market searches found for what it named.
 */
export function pagesRead(message: AuniUiMessage): readonly ReadPage[] {
  const pages = new Map<string, ReadPage>();
  for (const part of message.parts) {
    if (!isToolUIPart(part) || part.state !== "output-available") continue;
    const name = getToolName(part);
    for (const site of stepSites(name, part.input, part.output))
      if (!pages.has(`site:${site}`)) pages.set(`site:${site}`, { kind: "site", site });
    if (name !== FIND_PICKS) continue;
    for (const pick of picksNamed(part.input, part.output))
      if (!pages.has(`pick:${pick.name}`))
        pages.set(`pick:${pick.name}`, { kind: "pick", ...pick });
  }
  return [...pages.values()];
}

/**
 * The picks on the card a turn is putting together, as its proposal names them, each wearing the
 * logo its market searches found it by; null until it proposes one.
 */
export function picksChosen(message: AuniUiMessage): readonly PickWeighed[] | null {
  const steps = message.parts.filter(isToolUIPart);
  const proposal = steps.findLast((part) => getToolName(part) === PROPOSAL && part.input);
  if (!proposal) return null;
  const found = steps.flatMap((part) =>
    getToolName(part) === FIND_PICKS && part.state === "output-available"
      ? candidatesFound(part.output)
      : [],
  );
  return picksProposed(proposal.input, found);
}

/** The step that makes a take's card, whose picks the card's outline wears. */
const PROPOSAL = "propose_specialist_portfolio";
/** The market search, whose picks the pile lands. */
const FIND_PICKS = "find_instruments";
/** The steps that read the web, whose sites the reading pile lands. */
const WEB_STEPS = new Set(["WebSearch", "WebFetch"]);
/** The steps that make a position's card. */
const CARD_STEPS = new Set([PROPOSAL, "propose_actions"]);

/** Whether a turn is reading the web right now: a search or a page it has asked for and not had. */
export function readingTheWeb(message: AuniUiMessage): boolean {
  return message.parts.some(
    (part) =>
      isToolUIPart(part) &&
      WEB_STEPS.has(getToolName(part)) &&
      (part.state === "input-streaming" || part.state === "input-available"),
  );
}

/**
 * How far a turn has got towards a position's card: researching (it has read the web or searched
 * the markets), or putting the card together; null before either.
 */
export function towardsACard(message: AuniUiMessage): "researching" | "making" | null {
  const steps = message.parts.flatMap((part) => (isToolUIPart(part) ? [getToolName(part)] : []));
  if (steps.some((step) => CARD_STEPS.has(step))) return "making";
  return steps.some((step) => step === FIND_PICKS || WEB_STEPS.has(step)) ? "researching" : null;
}
