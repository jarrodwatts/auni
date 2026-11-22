import type { Request } from "express";

// The owner's session is the tap: whoever is at a paired browser can allow an everyday move. A
// few things also take proof that the owner is there: a first withdrawal to an address, a raw
// transaction a tap can't vouch for, and showing the wallet's keys. The proof is the request
// itself, judged by requireOwner (auth/middleware.ts) as it lets the request in:
//
//   always on         The request came through Tailscale from the owner's own device
//                     (auth/tailscale.ts). The owner chose their device as the proof: it is signed
//                     in to their Tailscale account, which is what lets anything reach Auni.
//   on this computer  The request's own session was made in the last 15 minutes. Pairing takes
//                     the terminal where Auni runs, which already reaches the keys, so it is the
//                     root of trust. Its time is the database's own record of the session,
//                     judged by the database's clock, never anything the request says.
//
// Nothing else is proof: a channel's tap and the agent's token carry none.

/** Whether this owner's request proves the owner is there, as requireOwner judged it. */
export function ownerHere(req: Request): boolean {
  return req.ownerHere === true;
}

/** Why a request proved nothing, as the web reads it: the way on is `auni pair`. */
export type ProofRefusal = "pair_again";
