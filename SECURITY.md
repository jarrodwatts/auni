# Security

Auni signs real transactions with its owner's keys. It is unaudited: treat it that way, and start
small.

## Reporting a problem

Report it privately, through GitHub: the repository's **Security** tab, then **Report a
vulnerability**. If that button isn't there, open an issue titled "Security contact" that says
nothing about the problem, and we'll reply with a private way to send it. Please don't put the
details in a public issue or anywhere else public, and don't test it against anyone else's Auni or
anyone else's money. Use your own install and a wallet you control.

Say what goes wrong, the steps or input that cause it, and what it would let someone do. A failing
test or a short script is the best report there is.

This is a volunteer project with no bug bounty. We reply as soon as we can, fix what's real, and
credit you in the fix unless you'd rather not be named. Only the latest `main` gets fixes.

## What counts

Auni is built so that the AI it runs is never trusted with anything that matters. Anything that
breaks one of these is a security problem:

- **A move that isn't its card.** A transaction that sends a different amount, asset, chain or
  destination than its card showed, grants an approval or power the card didn't, or sends twice.
- **A move nobody allowed.** Anything signed without the owner's tap, outside a specialist's own
  pot, or without proof the owner is there where `apps/core/src/money/step-up.ts` takes it:
  their own browser's pairing in the last 15 minutes, or always on, a request from their own
  device through Tailscale (`apps/core/src/auth/proof.ts`).
- **A forged card.** Anything the AI writes, or a page it reads, that shows the owner a card core
  didn't make, or makes an Allow run something else (`apps/core/src/agent/card-seal.ts`).
- **A way out of the box.** The agent's shell or tools reading the keys, the database, a login or
  the data folder, or reaching core, Postgres or this machine's network
  (`apps/core/src/agent/box.ts`, `apps/core/src/apps/brain.md`), including through `fetch_url`
  (`apps/core/src/agent/fetch-tool.ts`), which core dials for the agent, at any redirect; or the
  turn token reaching anywhere but core (Claude Code reads it from a 0600 file in the data folder).
- **A key or secret leaking** into a log, an error, the agent's box or the web bundle.
- **Someone who isn't the owner** reaching an owner route, pairing a browser, passing for a
  browser paired in the last 15 minutes, or getting past the Host and Origin checks
  (`apps/core/src/auth/`); always on, passing for the owner's Tailscale login, reaching core's
  door other than through `tailscale serve`, or being let in from the machine Auni runs on
  (`apps/core/src/auth/tailscale.ts`); or, on a chat app such as Telegram, being taken for the owner or
  allowing a card (`apps/core/src/channels/hub.ts`).
- **An update that isn't a release.** `install.sh` or `auni update` installing anything but a
  release signed with a key the running Auni lists, source other than the bytes its release
  names, or an older release offered as the newest (`RELEASING.md`).
- **A request from outside acted on** before its signature is checked, should an app add a
  route a service calls (core serves none).

## What doesn't

- A machine that is already compromised: whoever runs code as the owner can do what the owner can.
- The venues' own contracts and APIs. Report those to the venue.
- An owner who allows a card that says plainly what it does.
