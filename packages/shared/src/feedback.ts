import { z } from "zod";

import { cardBaseSchema } from "./card-base.ts";
import { AUNI_REPO_URL } from "./repo.ts";

/**
 * What the owner can tell Auni's maintainers from inside Auni: ask for an app for a service
 * Auni has none for, report something broken, or suggest something. Auni sends none of it. A
 * card shows exactly what would be posted, and one button opens GitHub's own form, filled in,
 * under the owner's own account, where they press Submit.
 */
export const FEEDBACK_KINDS = ["app", "bug", "idea"] as const;

/** One thing that would be posted: what it is, and its words exactly as they would be posted. */
const feedbackPartSchema = z.object({
  /** The field of the issue form it fills: its `id` in `.github/ISSUE_TEMPLATE/<kind>.yml`. */
  field: z
    .string()
    .regex(/^[a-z][a-z-]*$/u)
    .max(24),
  label: z.string().min(1).max(60),
  value: z.string().min(1).max(4_000),
  /**
   * The same in the owner's words, when `value` is a name only a maintainer knows (a tool's
   * id, a failure kind): the card says this first and what is posted beside it. Never posted.
   */
  reads: z.string().min(1).max(200).optional(),
});
export type FeedbackPart = z.infer<typeof feedbackPartSchema>;

export const feedbackSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  /** What the card is, as its title: "Ask for a Lido app". */
  heading: z.string().min(1).max(80),
  /** What sending it would do for the owner, in a sentence. */
  why: z.string().min(1).max(200),
  /** The issue's title: "App request: Lido". */
  title: z.string().min(1).max(120),
  /** What is posted whatever the owner ticks. */
  always: z.array(feedbackPartSchema).max(12),
  /**
   * What is posted only once the owner ticks it, since it could point at their wallet: each
   * says how, in `warning`.
   */
  optional: z.array(feedbackPartSchema.extend({ warning: z.string().min(1).max(240) })).max(4),
  /** The words that find the same thing among the issues already open: "Lido". */
  search: z.string().min(1).max(60),
});
export type Feedback = z.infer<typeof feedbackSchema>;

/** What `GET /feedback` answers: a report the owner started themselves, with no turn behind it. */
export const feedbackWireSchema = z.object({ feedback: feedbackSchema });

/** A piece of feedback as a card under the agent's reply (the send_feedback tool). */
export const feedbackCardSchema = cardBaseSchema.extend({
  kind: z.literal("feedback"),
  feedback: feedbackSchema,
});

/**
 * Where every piece of feedback goes: Auni's own repository on GitHub. It is fixed here, so
 * nothing a card carries can send the owner's browser, or what they post, anywhere else.
 */
const ISSUES = `${AUNI_REPO_URL}/issues`;

/** The longest address the button opens. GitHub refuses a far longer one, and so do browsers. */
export const FEEDBACK_URL_LIMIT = 6_000;

/** The issue form's last field, which holds everything posted again as JSON, for an agent to read. */
const AS_DATA = "details";

/** What would be posted, as the owner has it now. */
export interface FeedbackPost {
  /** GitHub's new-issue form for this kind, with each part in the field it belongs to. */
  readonly url: string;
  /** All of it as text, uncut: what Copy gives. */
  readonly text: string;
  /** Whether the address had to leave some of a long part out to stay short enough. */
  readonly cut: boolean;
}

/** The parts that would be posted: every one that always is, and each optional one in `ticked`. */
function posted(feedback: Feedback, ticked: ReadonlySet<string>): FeedbackPart[] {
  return [...feedback.always, ...feedback.optional.filter(({ field }) => ticked.has(field))].map(
    ({ field, label, value }) => ({ field, label, value }),
  );
}

const asData = ({ kind, title }: Feedback, parts: readonly FeedbackPart[]) =>
  JSON.stringify({
    kind,
    title,
    ...Object.fromEntries(parts.map(({ field, value }) => [field, value])),
  });

/**
 * The form the button opens and the text Copy gives, for the parts the owner left ticked
 * (`ticked` holds the `field` of each). Nothing optional is in either unless it is ticked. An
 * address that would run past the limit loses the tail of its longest part, and says so in
 * `cut`: the text keeps all of it.
 */
export function feedbackPost(feedback: Feedback, ticked: ReadonlySet<string>): FeedbackPost {
  const whole = posted(feedback, ticked);
  const address = (parts: readonly FeedbackPart[]) =>
    `${ISSUES}/new?${new URLSearchParams([
      ["template", `${feedback.kind}.yml`],
      ["title", feedback.title],
      ...parts.map(({ field, value }) => [field, value]),
      [AS_DATA, asData(feedback, parts)],
    ])}`;
  let parts = whole;
  while (address(parts).length > FEEDBACK_URL_LIMIT) {
    const longest = parts.reduce((a, b) => (b.value.length > a.value.length ? b : a));
    // Never reached with parts a card can carry: there is nothing left worth cutting.
    if (longest.value.length <= 40) break;
    const kept = longest.value.slice(0, Math.floor(longest.value.length * 0.8)).trimEnd();
    parts = parts.map((part) => (part === longest ? { ...part, value: `${kept}…` } : part));
  }
  return {
    url: address(parts),
    text: [
      feedback.title,
      ...whole.map(({ label, value }) => `${label}\n${value}`),
      asData(feedback, whole),
    ].join("\n\n"),
    cut: parts !== whole,
  };
}

/** GitHub's form for a kind of feedback with nothing filled in, for when no card could be made. */
export function feedbackBlankUrl(kind: Feedback["kind"]): string {
  return `${ISSUES}/new?${new URLSearchParams({ template: `${kind}.yml` })}`;
}

/** The issues already open that say the same thing, for "See if someone already asked". */
export function feedbackSearchUrl({ search }: Pick<Feedback, "search">): string {
  return `${ISSUES}?${new URLSearchParams({ q: `is:issue ${search}` })}`;
}
