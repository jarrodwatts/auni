---
name: hyperliquid
description: Load before a leveraged trade, a perp of a crypto, stock or commodity, a change to an open perp or its stops, or moving cash into or out of Hyperliquid. Says how its sizes, prices, margin, fees and liquidations really behave, what each refusal means, and what Auni can and can't do there.
---

# Hyperliquid

Hyperliquid is an exchange for perpetuals: contracts that track a price with leverage and never
expire. The owner's account there is their own wallet address, kept in Hyperliquid's ledger and
on no chain. Its cash is USDC. What follows is how it behaves in fact, so you can reason from it.

## The account and its cash

- **One balance.** Auni puts the account in Hyperliquid's unified mode before its first order or
  withdrawal, so one USDC balance pays for every market on every dex. `get_portfolio` shows what
  is free as cash on Hyperliquid, each open position as a holding worth what closing it would
  return, and what limit orders still waiting hold as "Held for orders": the margin each would
  open with, still the owner's and in their total, back in free cash if it is cancelled.
- **Money in** is `hyperliquid_deposit`: USDC from the wallet on Arbitrum into the account,
  credited in about a minute. Cash elsewhere comes to Arbitrum first with the bridge tool, and
  the wallet needs a little ETH on Arbitrum for the network fee. A deposit and the order it pays
  for go on one card with `propose_actions`: the order runs once the deposit is credited. It
  goes by Circle's CCTP, which Hyperliquid's docs prefer: the wallet burns the USDC on Arbitrum,
  naming the owner's own account, and Circle's forwarder credits that account. Circle keeps a
  flat fee, $0.20 when this was written, so $10 arrives as $9.80; the card says both, and its
  figures are what Circle quotes as it is made. Nothing is lost for being small; the least is $1.
- A first deposit opens the account. Hyperliquid's docs say a new account pays a one-time $1,
  which it takes at the account's first withdrawal or transfer out, not from the deposit.
- **Money out** is `hyperliquid_withdraw`: signed by the wallet, paid out on Arbitrum by
  Hyperliquid's validators a few minutes later, to the owner's own address and nowhere else.
  Hyperliquid keeps a flat $1 of every withdrawal, so one must be over $2, and $500 lands as
  $499. It takes only free cash: margin held by open positions stays with them. Leave the
  amount out to take everything free. On one card it runs before every other move, so it can't
  take what a close on the same card frees: close first, withdraw when you are woken with the
  close settled.
- A deposit and a withdrawal stay running until they land, and this thread is woken then.
  Don't wait or poll. Every move on the account runs one at a time, in the order allowed.
- **Withdrawals go by Hyperliquid's own bridge** on Arbitrum, the legacy one, which was still
  paying them within minutes on 2026-11-12.
- A deposit that is never credited finishes saying so after 12 hours. If that happens, send no
  more, and tell the owner where the money went: it was burned on Arbitrum for Circle's
  forwarder, and Circle's record of that transaction says how far it got.

## Markets

`hyperliquid_markets` searches every dex by ticker and returns, for each match, the exact name
to trade, the mark price, the most leverage it allows, the day's volume and the hourly funding
rate. Read it before any order: every number below that varies by market comes from there.

- The main dex lists crypto under bare tickers (`BTC`). Other dexes are run by outside
  deployers and list stocks, indices and commodities under their dex's name (`xyz:NVDA`,
  `xyz:GOLD`). A deployer sets its own oracle and leverage limits and can halt a market, which
  cancels its orders and settles every position at the mark price. So a stock perp carries the
  deployer's risk as well as the price's. A ticker on more than one dex has to be named whole.
- A dex margins in one token. Auni funds only the ones that margin in USDC, and refuses the
  rest by name.
- The **mark price** is what margin, stops and liquidations go by. It is a median of
  Hyperliquid's own book and outside exchanges' prices, refreshed about every three seconds, so
  it can sit a little away from the last trade.

## What is open: `hyperliquid_open_orders`

`hyperliquid_open_orders` reads the account as Hyperliquid has it now, in three lists:

- `orders`: every limit order still waiting on the book, with how much of it has filled.
- `positions`: every open position, with the stop-loss and take-profit in place on it.
- `stopsWithNoPosition`: stops standing on a market where nothing is held yet. `protects` says
  which it is: there for whatever fills of the orders waiting on that market, or left over from
  an order that ended, with nothing to protect.

Read it before you tell the owner what protects a position, to find the order to cancel, and to
find a leftover stop to offer to remove.

## Opening: `hyperliquid_order`

- **`sizeUsd` is the position, not the money put in.** A $3,000 position at 3x puts in $1,000,
  which is the card's amount and comes out of the account's free cash. Hyperliquid takes no
  order under $10 of position. Coins are rounded down to the market's lot, so the position can
  come out a few cents under what was asked.
- **Leverage** is a whole number up to the market's own maximum, which runs from 3x on thin
  markets to 40x on bitcoin. Auni sets it on the market just before the order, always as
  isolated margin: the position can lose what was put into it and nothing else in the account.
  Adding to an open position sets the market's leverage again, so add at the position's own
  leverage unless a change is meant.
- **How far until it is gone.** Hyperliquid liquidates an isolated position when its margin
  falls to the maintenance margin, which is half the margin the market's maximum leverage
  would need. So the same leverage sits closer to liquidation on a market with a low maximum.
  As a share of the entry price the distance is
  `(1/leverage - m) / (1 - m)` for a long and `(1/leverage - m) / (1 + m)` for a short, with
  `m = 1 / (2 x the market's maximum leverage)`: a 3x bitcoin long (maximum 40x) goes at about
  a 32% fall, a 10x one at about 9%, and a 3x long on a market whose maximum is 3x at about
  20%. The card says this figure. A liquidation sells at the market and returns whatever
  margin is left; in a fast fall nothing is left. Funding paid along the way moves the price
  it happens at.
- **A market order** is sent as "fill now or cancel" with a worst price: the mark plus or minus
  `slippagePercent` (1% unless you say, 20% at most). That price is on the card and is never
  widened after the tap. If the mark has moved past it when the owner taps, nothing is sent. If
  the book can't fill inside it, Hyperliquid cancels the order and nothing opens. An order can
  fill in part: what filled is the position.
- **A limit order** rests on Hyperliquid's book at `limitPrice` until the market reaches it or
  it is cancelled. It opens nothing until then, and it can fill a part at a time. Hyperliquid
  refuses a limit price far from the market.
- **What it costs.** Hyperliquid charges a taker fee on every market order and close: 0.045% of
  the position at its base tier, so about 45 cents on $1,000 each way. A resting order that is
  filled pays the lower maker fee. Markets on outside dexes can charge more, as their deployer
  sets. The fee is taken from the account as the order fills, so leave a little free for it.
- **Funding** is paid every hour between longs and shorts: a long pays when the rate is above
  zero and is paid when it is below. An hour's payment is the position's size in dollars times
  the hourly rate, so a day costs about 24 times that. Rates drift with the gap between the
  perp and the price it tracks, and Hyperliquid caps them at 0.5% an hour. Over weeks, funding
  can outweigh the trade.

## Stops: the position's, held by Hyperliquid

A stop-loss or take-profit is an order resting on Hyperliquid that closes the position at the
market once the mark price reaches its trigger. Three things are true of every stop Auni sets:

- **It belongs to the position, not to the order that opens it.** A position has at most one
  stop-loss and one take-profit. Each is for the whole position, whatever size that is when
  the stop fires, so adding to a position needs no stop set again.
- **Hyperliquid holds it from the first moment.** `hyperliquid_order` sends the stops ahead of
  the entry, so they are in place before the first coin can fill, on a market order and on a
  limit order that fills a part at a time over days. Nothing depends on Auni running: it may
  be switched off, and the stop still fires. Auni's own reading is only for telling the owner.
- **A card that shows stops says what the position's stops will be.** If the position has one
  of that kind already, the card says what it moves from, and the old one comes off once the
  new one is on. A kind the card doesn't name stays as it is.

What follows from that:

- A stop has to sit on the far side of the price now: below it for a long's stop-loss or a
  short's take-profit, above it for the reverse. One on the near side would fire at once, so
  Auni refuses it before making a card. **On a limit order this means the price now, not only
  the limit**, because the stop rests from the moment the order is placed. A take-profit
  between the limit and today's price can't go on the order: place the order without it, and
  set it with `hyperliquid_set_stops` once the order has filled. A plain fill posts its news
  in this chat without waking you, so set a price watch at the limit if you want to be woken
  to do it, and tell the owner that is the plan.
- **A stop reached while nothing is held is used up.** Hyperliquid drops it, with nothing
  bought or sold. For a stop-loss the price would have to pass the entry without filling it,
  which an ordinary market doesn't do. For a take-profit it only takes the price running to the
  target before a resting order fills. The card says so. When that order then fills, Auni reads
  the position, finds the take-profit gone, says so on the news of the fill and wakes this
  thread: tell the owner, and offer `hyperliquid_set_stops`. While Auni is off the position
  still has its stop-loss; only the take-profit waits for the telling.
- An order with stops can't trade against an open position (a long with stops while a short is
  open is refused): close first, or send it without stops.
- **A stop closes one side only**: a long's sells, a short's buys. So an order with stops is
  refused while an order of the other way still waits on that market (its stops would come
  off), and a stop-loss is refused where it sits between the price now and the limit of an order
  still waiting on its side: it would fire first and be used up, and that order would then fill
  with none. Cancel the waiting order, or set the stop-loss past its limit.
- If Hyperliquid refuses the entry, the stops sent ahead of it are taken back off, and the
  failure says so. If it refuses a stop, the entry is never sent. If Hyperliquid never answers
  the entry, the stops stay, since the order may be on the book.
- A triggered stop fills at the market, up to 10% past its trigger. In a gap it can fill well
  past the trigger, and if the price is already more than 10% beyond it, it waits unfilled.
- `hyperliquid_set_stops` sets, moves or removes the stops of an open position: the new one
  goes on before the old one comes off, `null` removes one, and a field left out keeps it.
- An order the owner placed in Hyperliquid's own app can carry stops attached to the order
  itself. Those are placed only once that whole order has filled and protect nothing until
  then; `hyperliquid_open_orders` lists them under their order as `stopsWaitingOnIt`, never as
  the position's.
- Never tell the owner a position is protected from what a card said: read
  `hyperliquid_open_orders`.

## Cancelling an order: `hyperliquid_cancel_order`

Takes a limit order that is still waiting back off the book, by the id `hyperliquid_open_orders`
gives it. Nothing is bought or sold, and the card needs only a tap.

- Any part of the order that has already filled stays open as the position, and keeps the
  position's stops. The card says how much, and the move finishes with a note of what had
  filled by the time it was cancelled and what protects it.
- With nothing filled and no other order waiting on that market, the stops sent with the order
  would be left with nothing to protect, so they come off in the same move, and the card names
  them. While a position is open, or another order still waits there, they stay.
- **A leftover stop.** If an order of Auni's ends somewhere Auni didn't see (cancelled in
  Hyperliquid's own app, or by Hyperliquid), its stops stay behind, and would close the next
  position opened on that market. `hyperliquid_open_orders` lists one under
  `stopsWithNoPosition` as protecting nothing. Offer to remove it: `hyperliquid_cancel_order`
  with the stop's own id makes that card. The next `hyperliquid_order` on that market takes
  leftovers off too, and its card says so.
- It cancels only the order its card showed. A stop on an open position is not cancelled here:
  `hyperliquid_set_stops` with `null` removes one.

## Closing: `hyperliquid_close`

Closes all or a percent of a position at the market, with a worst price as an order has. It
never closes more than its card showed: a position that grew since the card closes the card's
size, one that shrank closes what is left, and one that changed sides is refused. What comes
back is the position's margin plus what it made or less what it lost, into the account's free
cash, where it can pay for the next order or be withdrawn. Closing all of a position takes its
stops off with it, unless an order still waits to open more of it: then they stay, for what
that order fills, and the card says so. A part smaller than the market's lot, or worth less than
Hyperliquid's $10 minimum, is refused before a card is made, saying the least part it takes;
the whole position closes at any size.

## What Hyperliquid does by itself

A stop firing, a liquidation, and auto-deleveraging (Hyperliquid closing a winning position
against a bankrupt one, at the previous mark price, when a liquidation can't be filled) all
happen without a move of Auni's. Auni reads them from the account's fills, records them, and
wakes the thread with what happened and what it locked in. A trade the owner makes in
Hyperliquid's own app is read the same way.

## When it refuses

A refusal fails the move with nothing bought or sold, in a sentence the owner also reads.
What each means, and the next move:

- **No account yet.** The wallet has never deposited. A deposit of $5 or more opens the
  account; put it on the same card as the order.
- **Not enough free cash.** The margin is more than is free, or leaves nothing for the fee.
  Deposit, close something, or make the position smaller.
- **The price moved past the card's worst price.** The market ran, or the book was too thin
  inside the limit. Offer a fresh card at the price now, or with a wider `slippagePercent` if
  the owner accepts a worse fill, or a limit order if they would rather wait.
- **Under $10.** Raise the size, or close the whole position instead of a small part.
- **Nothing to close.** The position was already closed, by a stop, a liquidation or the owner.
  Read `get_portfolio` and tell them what happened to it.
- **The stop's price.** It is on the near side of the mark price, which may have moved since
  you read it. Read the market again and set it further out.
- **Nobody quoting, or the market is at its cap on open positions.** Both pass. Try later, or
  use a deeper market that tracks the same thing.
- **A price too far from the market, or a position too large for its leverage.** Bring the
  limit price nearer, or lower the size or the leverage.
- **The order is no longer open.** A cancel found its order already filled or already
  cancelled, and the sentence says which. Nothing was signed. If it filled, the position is
  open: read `hyperliquid_open_orders` and say what protects it.
- **No answer.** If Hyperliquid never answered an order or a withdrawal, it may have gone
  through, so the move stays open instead of failing. Read `get_portfolio` to see whether the
  position or the cash is there, and never send it again on a guess.

## What Auni can't do there

It can't change a resting order's price or size (cancel it and place another), change a
position's margin without trading, use cross margin, trade Hyperliquid's spot markets, place a
stop that fills only at a limit price, trails the market, or closes only part of a position,
set a stop before any order or position exists for it, fund a market that margins in
anything but USDC, move cash in from any chain but Arbitrum, withdraw by CCTP, or withdraw to
any address but the owner's own on Arbitrum. From there, cash leaves Auni the usual way. Even a
thread set to act on its own still asks before every perp move.
