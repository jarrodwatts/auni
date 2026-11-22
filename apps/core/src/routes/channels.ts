import { Router } from "express";

import { mintChannelPairing } from "../channels/hub.ts";

/** The owner's channels (channels/hub.ts), behind requireOwner. */
export const channelsRouter = Router();

/**
 * A one-time code (15 minutes) that pairs whoever sends it to the channel, in a direct chat, as
 * the owner there, and how to send it.
 */
channelsRouter.post("/:channel/pairing", async (req, res) => {
  const pairing = await mintChannelPairing(req.params.channel);
  if (!pairing) return void res.status(404).json({ error: "channel_not_set_up" });
  res.json(pairing);
});
