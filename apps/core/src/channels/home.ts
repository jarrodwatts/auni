import { isNotNull } from "drizzle-orm";

import { theOwner } from "../auth/owner.ts";
import { db, type Tx } from "../db/client.ts";
import { channelLinks, owner } from "../db/schema.ts";
import { channels, offered } from "../apps/registry.ts";

// The owner's home channel: where what Auni says unasked (a move landing, a watch the triage woke
// it for, the daily brief) goes besides the web app, which shows everything anyway.
//
//   owner.home_channel   a channel id  -->  that channel, while it is set up and paired
//                        "web"         -->  the web app alone
//                        null          -->  owner.last_channel: wherever they last talked to
//                                           Auni (a message, a tap, a pairing); null is the web

export interface PairedChannel {
  readonly id: string;
  readonly name: string;
}

/** A channel app on this machine, as Settings shows it. */
interface ChannelState extends PairedChannel {
  /** It has what it needs to connect (its token). */
  readonly configured: boolean;
  /** Its owner has paired their chat, and it is configured. */
  readonly paired: boolean;
}

/** Every channel app, whether it's set up and whether its owner has paired their chat. */
export async function channelStates(): Promise<ChannelState[]> {
  const linked = new Set(
    (
      await db
        .select({ channel: channelLinks.channel })
        .from(channelLinks)
        .where(isNotNull(channelLinks.chat))
    ).map(({ channel }) => channel),
  );
  // One the owner turned off is not listened on or sent to, so it is no place to send news.
  const on = new Set(channels(offered()).map(({ about }) => about.id));
  return channels().map(({ about, channel }) => ({
    id: about.id,
    name: about.name,
    configured: channel.configured(),
    paired: on.has(about.id) && channel.configured() && linked.has(about.id),
  }));
}

/** The channels set up on this machine whose owner has paired their chat. */
export async function pairedChannels(): Promise<PairedChannel[]> {
  return (await channelStates()).flatMap(({ id, name, paired }) => (paired ? [{ id, name }] : []));
}

/**
 * Whether the owner may choose this as home: null (wherever they last talked), "web", or a
 * channel they've paired. The agent's set_notices and Settings both ask this.
 */
export function canBeHome(choice: string | null, paired: readonly PairedChannel[]): boolean {
  return choice === null || choice === "web" || paired.some(({ id }) => id === choice);
}

/** The channel background answers go to, or null for the web app alone. */
export async function homeChannel(): Promise<string | null> {
  const me = await theOwner();
  // A chosen channel that is no longer set up or paired falls back to the web, never elsewhere.
  const home = me.homeChannel ?? me.lastChannel;
  if (!home || home === "web") return null;
  return (await pairedChannels()).some(({ id }) => id === home) ? home : null;
}

/** The owner just talked to Auni here: a channel's id, or null for the web app. */
export async function usedChannel(executor: Tx | typeof db, channel: string | null): Promise<void> {
  await executor.update(owner).set({ lastChannel: channel });
}
