# Adding a channel

A channel is a chat app the owner talks to Auni in besides the web app, such as Telegram. It joins
the same conversation: one memory, whichever app a message came from. `pnpm scaffold <id> --with channel`
writes one to start from, which stays off (`configured()` false) until its TODOs are written; copy
the rest from `telegram/`.

A channel only carries messages. Core's hub (`../channels/`) does everything that decides
anything, so a new channel can't get it wrong:

```
  channel.listen  -->  hub.receive(event)
                         |  from the paired owner (stable id), in their direct chat?  else nothing
                         |  a message: into the thread of the message it replies to, else the
                         |    owner's main chat (conversation/send.ts, as the web app sends)
                         |  a press:   Allow or Decline with the grant drawn on that message,
                         |    through money/decide.ts, the web app's own path; or a question's answer
                         |  a hello:   the app's own start or help, answered by the hub itself
                         v
  a turn's answer  -->  a deliver job, queued with it  -->  channel.send(chat, { text, buttons })
                         to the channel the owner's message came from; said unasked, to their
                         home channel
  a move's status  -->  syncCards (a loop in the channels job, a few seconds after the last)
                                                          -->  channel.edit(ref, ...)
```

A channel is a `Channel` (`contract.ts`, which documents every method):

- `configured()`: it has its token. Unset, the hub leaves it off, and Settings shows `setup`, what
  the owner does to set it up (Telegram: make a bot, set `TELEGRAM_BOT_TOKEN`).
- `listen(receive, signal)`: connect outbound (long polling, a websocket), so the owner needs no
  public URL, and hand the hub each event in order, until `signal` aborts. The hub runs it inside
  the `channels` job (`channelsJob`), so only the Auni holding the job runner's lock listens; a
  sleep or a stop aborts it, and it is called again 5 seconds after it returns or throws
  (`jobs/keep-running.ts`), so it may simply give up on an error it can't ride out. Report `from` as the sender's stable id (never
  a name they can change), `chat` as the conversation it came in, and `direct` only for a
  one-to-one chat with Auni. Answer a press with what `receive` returned. Hand the app's own
  commands for opening a chat or asking how it works as a `hello` (Telegram: /start, with the
  pairing code a link carries, and /help), never as a message: the agent never hears them.
- `send(chat, message)` and `edit(ref, message)`: draw the hub's message as the app can. `text` is
  markdown; escape everything the app's own markup could read. A button is a `press` (its data
  comes back exactly) or a `url`. Return a ref for each message sent, the buttons under the last.
  A ref (and a message event's `id`) must never be another message's, even after the owner moves
  to a new bot or account, so put the account in it (Telegram: `<bot id>:<chat id>:<message id>`).
  `edit` returns false for a message it never can edit again (deleted), and the hub lets it go.
- `typing(chat)` and `pairingHint(code)`: show an answer is coming, and tell the owner how to send
  the pairing code (Telegram: a `t.me/<bot>?start=<code>` link).

## Pairing

`auni pair --channel <id>` (or Settings' Pair button, `POST /channels/<id>/pairing` from the
owner's session) gives a one-time code, good for 15 minutes. Whoever sends it in a direct chat becomes the owner on that
channel. Only its hash is kept (`channel_links`).

## What the hub guarantees

- Every button is drawn by the hub from the action rows, never from the agent's words. A card
  waiting for a tap carries a grant: random, kept as a hash, bound to that message and the card's
  digest, spent by one press, dead after a day (`channel_deliveries`). The agent never sees one.
- A card that takes proof the owner is at the computer (`auth/proof.ts`), or a plan that needs
  money added first, links to the app instead; even a forged grant would reach `allowAction`,
  which takes no proof from a channel.
- One decision wins: whichever app's tap comes first moves the action, and every other copy is
  redrawn to say where it was decided.

The tests in `telegram/approvals.db.test.ts` run the agent's ways of approving its own card
against a fake Bot API (`telegram/fake-bot-api.ts`); a new channel should pass the same table.
`telegram/home.db.test.ts` checks where answers said unasked go.

## The home channel

What Auni says unasked (a move landing, a watch the triage woke it for, the daily brief, money
that moved without Auni) goes to the owner's home channel as well as the web app
(`../channels/home.ts`): the one they picked (`owner.home_channel`, which the agent sets with
`set_notices` when they ask, or they pick in Settings: `PATCH /me` `home_channel`), or else wherever they last talked to Auni (`owner.last_channel`: a
message, a press or a pairing there, or a message from the web app, which keeps it to the web). A
home channel that isn't set up or paired any more falls back to the web app. An answer that settled
quietly (`settle_quietly`) stays in the web app. An answer to the owner's message goes back to the channel
it came from, never also home, so nothing is sent twice.

Every answer is sent by a `deliver` job queued in the transaction that stores it, one channel's
answers in order, and never sent again once begun. It draws the same messages either way, so a card
in a notice carries a grant like any other.
