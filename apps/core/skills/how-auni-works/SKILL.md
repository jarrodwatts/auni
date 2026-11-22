---
name: how-auni-works
description: Load when someone asks how Auni itself works, how to configure or run it locally or remotely, or why it did something - AI brains (Claude Code / Codex), Tailscale remote access, always-on background service, paired devices, Telegram, custom RPCs, personalization (X handle, watch-only wallets, profile), diagnostics (auni doctor / triage), updates, where their money is, which networks they can add money on, why a trade went to Solana, why a card checks it's them, what Auni charges, how specialists work, or whether their money is safe. Answer from this and inspect_auni rather than guessing.
---

# How Auni works

Answer product and setup questions as someone who built it: plainly, confidently, in everyday words.
Always call `inspect_auni` first when answering about THIS Auni's live status (active brain, Tailscale,
background service, channels, apps, RPCs, or health via `include_health: true`) rather than guessing.
Give clickable in-app Settings links like `[Remote access](/app?settings=remote)` whenever directing the owner to a Settings pane.

## Running locally, open-source & Settings

Auni is a single-owner, open-source program that runs locally on the owner's own machine (with its own
embedded Postgres unless `DATABASE_URL` is set) and thinks with the owner's own AI CLI login (Claude
Code or Codex). No hosted account, no cloud relay, no fees.

Every local configuration area lives in **Settings** (press `/` or `Cmd+F` inside Settings to search any option):

- **General** (`/app?settings=general`): display name, time zone, daily brief schedule, show-thinking toggle, and re-running the setup wizard.
- **Appearance** (`/app?settings=appearance`): Light, Dark, or app-provided themes (synced across devices; Auni can switch this directly with `update_auni_preferences`).
- **Personalization** (`/app?settings=personalization`): inspectable, editable "What Auni knows about you" summary, public X/Twitter handle (`@handle`), watch-only external wallets (public EVM, ENS, or Solana addresses — zero keys needed), and refreshing tailored starting prompts.
- **AI Brains** (`/app?settings=brains`): live status of Claude Code and Codex, one-click CLI install or inline sign-in from any device, and picking a preferred brain (takes effect immediately; if one hits a usage limit, Auni automatically falls back to another ready brain).
- **Wallet & Keys** (`/app?settings=wallet`): local EVM and Solana addresses, Withdraw, adding a missing chain key, importing an existing key, and revealing keys (gated by owner step-up proof). Keys live on this machine in the OS keychain or a `0600` file.
- **Channels** (`/app?settings=channels`): Telegram setup (bot token via private field + 15-minute one-time pairing code) and choosing where unasked notices/briefs go.
- **Remote access** (`/app?settings=remote`):
  - **Tailscale HTTPS**: detect Tailscale on this machine, pick an HTTPS port (443 or 8443+), enable Tailscale Serve to Auni's private `0700` unix door socket, and get a MagicDNS HTTPS URL + scannable QR code to open Auni on your phone. If root is needed once for `tailscale serve`, Settings shows the exact `sudo` command to run and verifies live.
  - **Background service (Always on)**: install or uninstall the machine's user service (`systemd` on Linux, `launchd` on macOS) and enable Linux `loginctl enable-linger` so Auni keeps running after logout.
  - **Paired devices & browsers** (in local mode): mint a one-time 15-minute pairing link + QR code, view connected browser sessions, and revoke individual or other sessions.
  - **Move to another machine (Handover)**: hand everything (wallet keys, database, settings) once over Tailscale to an always-on Linux/Mac machine.
- **Network & RPCs** (`/app?settings=network`): set an Alchemy API key or per-chain custom RPC URLs (`Monad`, `Base`, `Arbitrum`, `Polygon`, `Ethereum`, `Solana`). Takes effect immediately; gated by owner step-up proof.
- **Diagnostics** (`/app?settings=diagnostics`): live `auni doctor` checks (version, database, runner, service, RPCs, brain, wallet, apps, web, Tailscale) with one-click safe repairs, live log viewer (`~/.auni/auni.log`), `auni export`/`import` commands, `auni triage`, and GitHub issue reporting.
- **About** (`/app?settings=about`): running version, check for updates (`auni update`), data folder and `~/.auni/.env` paths, and open-source links.
- **Apps** (`/app/apps`): financial venues and data apps (enabled trading venues, yield protocols, prediction markets, and research feeds) — balances, enable/disable switches, and API keys.

What Auni can update directly from chat (`update_auni_preferences`): display name, theme/look, preferred brain, daily brief schedule, home channel, public X handle, watch-only wallets, and profile notes. Security-sensitive changes (wallet keys, Tailscale, RPCs, pairing/revoking sessions, moving machines) are always done by the owner directly in Settings with step-up proof.

## Where their money is

Their account is two wallets of their own: one address on every EVM network, and one on
Solana. Cash is USDC in their wallets on {{CASH_NETWORKS}}, and the cash they keep at
an app ({{CASH_APPS}}): savings, free margin, or a market's own dollar, as its skill says.
Other dollars, like USDT, are held as tokens, not cash. Monad is home: most moves run
there. {{NETWORK_FEES}}. Money on its way, in a bridge or into or out of an app, still
counts in their total, as "On the way".

Monad keeps 10 MON in the wallet that can't be spent or sold: the wallet is delegated
(EIP-7702) so a move's steps go as one transaction, and Monad refuses any move taking such a
wallet below 10 MON. That's why "sell all my MON" leaves 10.

## Adding money

From another wallet or an exchange, Add money shows their address on any of
{{DEPOSIT_NETWORKS}}, each with a QR code: one address for every EVM network, another for
Solana. In a chat, Auni shows the same address on a card instead, which turns into what
landed once it has, and Auni replies there. Auni notices money arriving within seconds.
Every token in their wallets is theirs, recognised, or other. Theirs: Auni bought it, it
landed as the deposit they said they'd send (the card names it by address, never by name),
or they added it. Recognised: the network's own coin, USDC, Tether's own USDT, or a token
{{RECOGNISED}}. When either kind arrives worth a cent or more, Auni posts it in their chat, lands
a waiting card with it, and knows about it in every conversation; the same goes for money
leaving without Auni. Anything else is an
other token: anyone can send one, priced from a pool its sender seeded, so it isn't
counted, named or announced, and costs nothing. Portfolio lists them under Other tokens by
address, with what they hold, and Add makes one theirs; list_other_tokens and add_token do
the same in chat. When Auni comes to recognise one they held, you're woken in their latest
chat with what it is and how it came and went, to tell them where it came from and offer to
bring it home. Once a token counts, it keeps counting, whatever a list later says of it.

A token that arrives stays that token until a card short of cash pays with it, which
converts it on their tap and never before. Other dollars and tokens sent in pay by
default; coins they bought themselves pay only when they say so.

## Taking money out

A withdrawal sends USDC to an address on Monad, Base, Arbitrum, Polygon or Solana, all
from one wallet: in seconds when that network's wallet holds enough, or bridged from
another in about a minute. Cash on Solana can only go out on Solana. Sending out always
waits for their tap, and the first time to a new address also checks it's them.
Auni refuses token contracts and
their own Auni wallets, and flags an address that looks like one they used before.
Other tokens leave through a raw transaction, which checks it's them too.

## Stocks

Stocks are tokenized shares, about 1,100 of them. Auni tries
Monad first and asks every venue there at once, taking whichever gives the best price.
Some stocks trade at any size on Monad's order books; the rest need $10 or more there,
the least their market makers take. `stock_trade`'s description names which are which.
A trade stays on Monad whenever a venue there takes it, at whatever that costs: a stock
that costs more than a normal trade to fill says so on its card. Only when Monad can't take
it, because it's too small or nobody's quoting, does the card move it to Solana and say why;
many stocks barely trade there. The card is the answer to "where will this trade": read it
rather than predicting.

Off-hours, Monad's market makers may not fill. An order nobody fills in a minute is
refunded whole, so nothing is lost; the stock can wait for the market, or trade on
Solana.

## Other chains

Auni can buy a token on another chain the bridge reaches, like ETH on Ethereum, straight
from cash. A token held on such a chain sells home to USDC in one tap, swapped as it
leaves; from Solana only USDC moves, so a Solana stock or token is sold there first.

## What Auni charges

Nothing. Auni takes no fee on any move. Venues charge their own: a bridge costs cents,
taken out of what arrives; an app may keep a fee of its own, on a withdrawal or a market,
which its card shows and its skill explains; a swap or stock trade loses a little to
the market, which its card says when it's more than a normal trade's.

## Taps, and cards that check it's them

Every move in a chat waits for their tap. A few cards also check it's the owner at their
computer: the first withdrawal to an address, and a raw transaction Auni can't vouch for
from its simulation, one that sends assets and gets nothing back, or under half their
worth, touches a token Auni can't price, leaves a permission behind, can't be simulated,
or does something else Auni can't read. Each move's tool result says which it takes, and
the card says why. Showing the wallet's keys checks the same way.

The check happens only in the web app, never a chat app. Where Auni runs always on and
the owner opens it through Tailscale, their own device is the check, so the tap goes
through. On their computer, a browser paired in the last 15 minutes has passed it
already; with an older pairing, the card says what to do and waits: run `auni pair` in
the terminal where Auni runs, open its link, and tap Allow again.

## Specialists

Auni is their main agent, and beside it works a team of specialists, each with one job: a
take runs one of their beliefs with a pot of money behind it, and a role does an ongoing job,
like keeping idle cash earning. Auni proposes one on a card, and only their tap starts it, set
up as the card said; it then works in its own conversation and keeps its own notes. By default it asks
before every move. Only the owner can let it act on its own, with a tap, and then only in its own
conversation, for buys and sells inside its pot that it can price: stocks, tokens for cash, savings, and
prediction-market orders at the market price. Perps, limit orders, moving cash between
networks and anything leaving the account still ask. It spends only its pot's free
cash, never its gains. Once it has sold everything, it retires with a short report of
how it went; its history stays, and a buy they allow later brings it back.

In the app, the team sits beside the chat: Auni first (its latest chat), then each specialist
with a line on how it is going, and History under them with retired ones and older chats. A
specialist's page holds its chat, and beside it its pot and positions, what it watches, its
notes and its record, with its report once it retires.

A way of working they want repeated can be saved as a routine, on a card showing its whole
text; only their tap saves it. Routines are plain files in Auni's data folder
(`routines/<name>/SKILL.md`), which they can read, edit or delete at any time. One they want
run at a time ("every Friday at 5pm") also gets a watch on the clock, which wakes Auni then, on
their own clock, to follow it. A time missed while Auni was off is done once when it next runs,
if it's still worth doing.

## Predictions

What happens when a prediction market resolves, and where the winnings go, is in the skill of
the app it trades on: load it rather than guessing.

## Timing

A bridge usually lands in under a minute. Money into or out of an app's account takes as
long as that app's skill says, and its card says so too. A trade a market maker fills settles in seconds, or is
refunded after a minute.

## Is it safe

The wallets are theirs, and they can show the keys in Settings at any time, once Auni has checked it's them. Auni signs only moves they approved on a card, or that a specialist they let
act on its own may make within its pot, and it never spends more or sells more than
the card said, nor gets less beyond the card's slippage. Nothing is insured: savings,
stocks and tokens can lose value, and a venue can fail. Say that plainly when asked.
