# Auni

> [!WARNING]
> **Unaudited. Install and use it at your own risk.** Auni is early software that holds your
> wallet's keys and signs real transactions with real money, and nobody has audited it. Start with
> an amount you can afford to lose.

Auni is an AI agent for your own money that you run yourself. Tell it a take you have ("AI chips
win", "rates fall by summer") and it researches it, builds a position for it, and helps you manage
that position. Every money move is a card you tap to allow.

```
  you say something, a watch fires, a move lands
        |
        v
  Auni thinks, with your own AI (Claude Code or Codex, on your login)
        |
        v
  its tools look things up, or propose a move as a card
        |
        v
  you tap Allow  ->  your wallet signs  ->  the venue sends it  ->  Auni tells you how it went
```

## Try it

Paste this into Claude Code or Codex:

```
Set up Auni for me: https://github.com/jarrodwatts/auni
```

Your agent installs Auni, gets your AI logged in, starts it, and hands over at your browser. It
never sees your keys. Or install it yourself, on Linux or macOS:

```
curl -fsSL https://raw.githubusercontent.com/jarrodwatts/auni/main/install.sh | sh
auni
```

`auni` opens Auni in your browser, the first time already paired as yours. The installer builds
Auni from source on your machine, with nothing prebuilt by us: Node from nodejs.org (checked
against its published checksums), Auni's source from a release, and its dependencies from npm
(each checked against the lockfile). A release is used only when it is signed with Auni's
release key, a key that never goes near GitHub, and its source is exactly what it names
(`RELEASING.md`). To check the installer itself first, download it and print the fingerprints of
the keys it trusts:

```
curl -fsSLO https://raw.githubusercontent.com/jarrodwatts/auni/main/install.sh
grep '^auni-release' install.sh | cut -d' ' -f3- | ssh-keygen -lf -
```

Auni's owner publishes the same two fingerprints off GitHub, in DNS:

```
dig +short TXT _auni-release.auni.io
```

If they match, run it with `sh install.sh`.

On Windows, Auni runs inside WSL. In PowerShell,
`irm https://raw.githubusercontent.com/jarrodwatts/auni/main/install.ps1 | iex` installs it there,
or says how to add WSL first.

To look before you trust it with anything, run `auni demo`: the whole app with a made-up owner,
no login and no money, and a ten-minute tour of everything Auni does.

## What it does

- **Takes become positions.** A take gets its own specialist: a pot of holdings Auni builds and
  keeps an eye on. You can let a specialist buy and sell on its own, only within its own pot.
- **Monad first.** Anything Monad can do runs on Monad: tokenized stocks (xStocks), token swaps,
  savings. Other chains (Base, Arbitrum, Polygon, Solana) are there as fallbacks, alongside perps on
  Hyperliquid and prediction markets on Polymarket.
- **Watches.** Ask it to tell you when something happens (a price crossing a level, a sharp move,
  news on a name you hold) and it wakes up in that conversation when it does, if it judges the news
  worth your time; the rest waits for your brief, each morning or on the days and time you choose.
- **Where you talk to it.** Chat, cards, your portfolio and its history, in a web app on your own
  machine. Talk to it on Telegram too, and allow its cards there.

Each outside service is an app, one folder in `apps/core/src/apps/`: venues that move money
(Aave, Across, Hyperliquid, Jupiter, Kuru, KyberSwap, LI.FI, Polymarket), what says a token's
price and name (DefiLlama, LI.FI, CoinGecko, DexScreener, Backed), paying in from another chain
(Relay), watch sources (prices, Elfa's news), wallets (your own key, Privy), brains (Claude
Code, Codex) and chat apps (Telegram). Apps, in the web app, lists them: what you hold at each,
a place for the key one needs, and a switch on the ones you act through (off, Claude is offered
none of it, and what you hold there is still yours and still read). Auni offers one in the chat
when it would have helped. [How Auni is built](#how-auni-is-built) says how they fit.

## What it isn't

- **Not a service.** Nobody runs Auni for you. There are no accounts and no fees, and the authors
  never see your keys, your money or your conversations. You run it, on your machine or your own
  server, and it answers only to you.
- **Not a token.** There is no Auni token and there never will be. Anyone selling one is not us.
- **Not advice.** Auni is software you run. What it proposes is its own reading, and what you allow
  is your call. Venues have their own terms and aren't open everywhere; using only what's allowed
  where you live is up to you.

## Bring your own

- **AI.** Auni thinks with an AI CLI you are already logged in to on this machine: Claude Code (your
  Claude subscription, or an Anthropic API key) or Codex (your ChatGPT plan). It runs the CLI with
  your login, locked in a box, and never reads, stores or forwards the login itself. With both, the
  other answers while one is at its usage limit.
- **Wallet.** By default Auni makes keys on your machine when you choose to, kept in your OS
  keychain or a file only you can read (`~/.auni`). Used auni.io? Paste the keys its Settings
  exported instead, into a field whose value goes only to Auni on your machine (never its AI),
  for the same wallets and positions here. Or set `WALLET=privy` to use server wallets in your own
  Privy app.
- **Keys for data, if you like.** Some apps do more with a key of your own: Elfa's brings
  market news and news watches (price watches need none). Without one, its tools stay out of the
  way and Auni runs. Paste one into its app under Apps, in the web app, and it works at once,
  or set it in `~/.auni/.env`; `apps/core/.env.example` lists them all.

## Run it yourself

Auni thinks with Claude Code or Codex, on your own login. Sign one in from the web app, on any of
your devices: Auni asks for one in its chat the first time it needs to think, and each AI's sheet
in Apps has it too. Auni installs Codex
for you if it's missing. Or do it on the machine Auni runs on, in your own terminal:

```
curl -fsSL https://claude.ai/install.sh | bash  # Claude Code
claude auth login
sudo apt-get install bubblewrap socat           # on Linux, for Claude Code's sandbox
npm install -g @openai/codex                    # or Codex
codex login --device-auth
```

`claude auth status` and `codex login status` show each login. With both, `BRAIN=codex` (or
`claude-code`) in `~/.auni/.env` picks which answers first. Auni runs the Claude Code bundled with
its Agent SDK, on the same login (`CLAUDE_CONFIG_DIR` when you set one), or bills an Anthropic API
key you set as `AUNI_ANTHROPIC_API_KEY`; the `ANTHROPIC_*` your shell exports never reach it.

Auni is one program. `auni` runs its own Postgres (unless `DATABASE_URL` names yours), its API and
jobs, and the web app, then opens it in your browser. The first time it opens signed in as yours,
on one question, What do you believe?, and your answer is Auni's first chat. Your wallet is made as
you send it (or bring your auni.io one first), your AI and your money are asked for in the chat
only when the take needs them, and a spare key once its first trade has gone through. In a terminal,
a small Auni hops across what it starts as it starts it. `auni pair` prints a fresh one-time
link, for a new device or to show Auni you are at the computer (`--sign-out-everywhere` signs every
browser out first). Everything listens on 127.0.0.1 only. Running `auni` again while it runs just opens it.
`auni stop` stops it, whatever started it (a terminal, the background or the service), letting
moves it is making finish first.

Everything Auni keeps is in `~/.auni` (or `AUNI_HOME`): your settings in `~/.auni/.env`
(`apps/core/.env.example` lists them all), its database, your wallet's keys when no OS keychain
holds them, and the app itself in `~/.auni/app`. Only the Auni in `~/.auni` puts keys in the
keychain (on Linux, a Secret Service such as GNOME Keyring): a second Auni, with an `AUNI_HOME`
of its own to try something out, keeps its wallet's keys in that folder's `wallet-keys.json`, so
deleting the folder leaves nothing behind (and loses that wallet).

- **Updating.** `auni update` checks the newest release is signed with the release key your
  Auni already trusts, tells you its version, the day it was made and what changed, and asks.
  Then it stops Auni, builds the new one beside it, exports and copies your database, and
  switches. It tries the new one first with nothing running in the background, so no move is
  made twice; if it doesn't come up within a minute, it switches back and puts your data back as
  it was. Either way it starts Auni again as it was running (the service, or in the background),
  so the app comes back by itself. `auni doctor` says when a newer one is out.
- **Taking your data with you.** `auni export` writes everything Auni keeps (every row of its
  database, and your routines) to one file, and `auni import --from <file>` loads it into a new
  Auni. Your wallet's keys and your settings are not in it.
- **Adding money.** Add money in the app shows your Monad address and its QR code. Auni spends
  USDC; send 10 MON with it for network fees, which pays for dozens of moves, and Auni buys more
  with a little of your USDC as it runs low. Money sent on another network can still move: its
  first move there buys that network's coin for the fee with a quarter to a dollar of your money
  on Monad.
- **Something wrong?** `auni doctor` checks the version, the database, the jobs, the service,
  each chain's RPC, the brain, the wallet and the web app, and says what to fix. It offers the
  safe repairs (starting or restarting the service, starting it at boot) and asks about each;
  `auni doctor --fix` runs the recommended ones, `--dry-run` only lists them. Still stuck?
  `auni triage` starts your own Claude Code or Codex in the terminal to look into it with you,
  from what Auni logged and its source, and write it up as an issue. It never reads your keys or
  settings, and asks before it changes or posts anything.
- **Telegram.** Make a bot with @BotFather, paste its token into Telegram under Apps, and pair
  your chat there (or send the bot the code `auni pair --channel telegram` prints).
- **Keep it running.** `auni service install` makes it a service of this machine, started at
  login; `auni update` updates it too. `hosts/README.md` has recipes for Docker, Railway and Fly,
  and what a server needs.
- **Always on, from your phone too.** On a machine that stays on (a home server, a Mac mini, a
  VPS) with [Tailscale](https://tailscale.com) signed in as you, `auni up --always-on` makes Auni
  a service started at boot and has `tailscale serve` bring your devices to it, at
  `https://<machine>.<tailnet>.ts.net`. Auni then answers only your Tailscale account, from your
  other devices: nothing to pair, and a device you remove from your tailnet is out. It asks for
  root once, for `tailscale serve`. `auni doctor` says whether the machine keeps Auni running.
- **Removing it.** `auni uninstall` asks, stops Auni, removes the app, the command and the
  service, and leaves your data in `~/.auni`. It says where your wallet's keys are (`auni doctor`
  does too): a keychain entry outlives the folder. It removes them only if you type that you want
  the wallet gone, once you have saved its backup.

To work on Auni itself, clone it instead (Node 24 and `corepack enable`); `pnpm auni <command>`
there is `auni <command>`:

```
git clone https://github.com/jarrodwatts/auni && cd auni
pnpm install
pnpm start                                      # or pnpm dev, reloading on changes
```

## How it keeps your money yours

- **The agent can't touch the keys.** Its shell runs in a box that hides the keys, the database,
  your logins and this machine's network. Only Auni's own tools, which run outside the box, do
  anything that matters.
- **A card means what it says.** Core seals every card it makes, so nothing the AI writes can show
  one move and run another. When a move runs, it quotes again and refuses anything outside what
  the card showed.
- **Proof it's you for the risky ones.** The first withdrawal to a new address, a raw transaction
  a tap can't vouch for, and showing your keys also check it's you: the browser was paired in the
  last 15 minutes (`auni pair` in your terminal pairs it again), or, always on, your own device
  through Tailscale is the proof.
- **One owner.** Only you can allow a card: from a browser you paired, from your devices on
  Tailscale where Auni runs always on, or from a chat app you paired with `auni pair --channel`.

`SECURITY.md` says how to report a problem privately.

## Known limits

- **Your own keys pay their own fees.** With the default wallet, every move pays its network fee
  from the wallet: MON on Monad, ETH on the other EVM chains, SOL on Solana. Short of SOL, Auni
  buys some with USDC on Monad through Relay before the move, and its card shows that USDC as the
  network fee; with no USDC on Monad either, send it a little SOL. (`WALLET=privy` can sponsor
  fees on the chains your Privy app sponsors.)
- **Solana swaps take a Jupiter key.** Buying and selling tokens and stocks on Solana goes through
  Jupiter's API, which needs a key of your own, pasted into Jupiter under Apps (or
  `JUPITER_API_KEY` in `~/.auni/.env`). Without
  one, stocks trade on Monad, and with the default wallet USDC still moves to and from Solana by
  bridge or withdrawal.
- **Relay's key.** Buying a chain's coin for network fees from another chain goes through Relay's
  public API. Relay's docs say every call should carry a key; Auni calls without one, as Relay
  answers today. If Relay starts refusing, paste a key into Relay under Apps.
- **Codex's shell has no network.** With Codex, the agent reads the web only through Auni's own
  `fetch_url` tool (public addresses, a page at a time); Claude Code's shell can also reach the
  public internet through Auni's proxy. Codex also adds your own `~/.codex/AGENTS.md` to every
  turn; `apps/core/.env.example` says how to keep it out.
- **Some arrivals show late.** Auni finds deposits from each chain's own records. Coin a contract
  sends on (a bridge's delivery, on an RPC that serves no traces) shows in your balance at the
  next reading rather than as an arrival.
- **Linux first.** Auni is built and tested on Linux. `auni service install` knows systemd and
  macOS's launchd. Windows has no sandbox Auni can lock the agent's shell in, so there Auni runs
  inside WSL ([Try it](#try-it) says how) or Docker.

## For AI agents

If someone asked you to set up Auni for them, run the install line above, then follow
`auni setup --json` until it says stop; `skills/auni/SKILL.md` says how to act on each answer.
Never ask the person for a private key, a seed phrase or a login token, and never read a pairing
link: `auni` opens it in their browser itself.

## How Auni is built

Auni has one loop, and nothing you add to it changes that loop. Claude decides what to do with
your money. Auni's core runs it in a simulation and shows you exactly what it will do, as a
card. You tap Allow. Your wallet signs only what the card showed. So Auni can already do
anything a chain can do: Claude builds the transaction, and core reads what it does before
anyone signs.

An **app** makes one outside service great instead of merely possible. It is one folder,
`apps/core/src/apps/<id>/`, holding two layers over what Claude can already do:

- **What Claude knows and can do there.** A `SKILL.md` (the know-how, written down once),
  lookups, and moves: money tools for what a bare transaction can't say or hold, such as an
  order signed for an exchange.
- **How it reads.** The words on the card of a transaction Claude builds for it, the card of
  each of its own moves, its account (where your money sits there, what it is worth, how cash
  gets in and out), and what it says when something goes wrong.

An app can also do a job for Auni itself: quote a swap, bridge cash, price a token, think,
sign, carry messages, watch the world. Every part is optional, so an app comes in three sizes,
each finished at its size:

| Size     | In the folder                    | What you get                                                                          |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| Know-how | a `SKILL.md`                     | Claude stops working the same thing out twice.                                        |
| Reader   | plus the contracts it reads      | A transaction Claude built reads as a real card, under a name the repo vouches for.   |
| Venue    | plus moves, an account, problems | What a transaction can't do, held to its card, and able to run in a specialist's pot. |

```
  you                   Claude (the brain)                       the service, the chain
     |  ask                   |                                          ^
     |----------------------->|  what it knows and can do, from each     |
     |                        |  app: SKILL.md, lookups, moves           |
     |                        |  ...or it builds the transaction itself  |
     |       +----------------v------------------------+                 |
     | card  |  CORE: names no app, changes for none   | signs only what |
     |<------|  simulate > card > Allow > held to the  | the card showed |
     | Allow |  card > signed > recorded               |---------------->|
     |------>+-----^---------------^-------------^-----+
     |             |               |             |
     |       how it reads       account        jobs for Auni
     |       (card words,      (money that    (swaps, bridge, prices, brain,
     |        problems)         sits there)    wallet, chat, watches)
     |             +-- apps/core/src/apps/<id>/ --+     one folder a service
```

Three rules hold it together:

- **An app only proposes.** Core decides, seals the card, holds the move to it and signs. The
  dollars on a card, and everything that decides how it is approved, are core's own.
- **Core never names an app, and no app imports another.** A second service is a second folder.
- **With no app, Auni does it anyway.** Claude builds the transaction and core fills the card
  in from the simulation. An app makes that read well, fail well and need no rediscovery.

`apps/core/src/apps/AGENTS.md` is the same idea for whoever builds one.

## Make it yours

Auni is meant to be changed. Ask your coding agent to change any behaviour you like; the repo map
in `AGENTS.md` says where to start. To add a venue, a lookup, a watch source, a price feed, a
wallet, a brain or a chat app, `pnpm scaffold <id> --with <parts>` writes a working app to
start from, and `pnpm scaffold <id>` alone the know-how Claude reads about a service.
`CONTRIBUTING.md` says how to send it back.

## License

MIT. See `LICENSE`. The marks of the services, networks and tokens Auni names, and the
dependencies whose licences ask to be credited, are listed with their owners' terms in
`THIRD_PARTY_NOTICES.md`.
