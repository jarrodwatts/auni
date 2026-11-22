---
name: polymarket
description: Load before a bet on a prediction market, selling one, bringing its cash back, or answering what happened to one. Says how its prices, fees, minimums, order book, settlement and resolution really behave, where its cash sits and how it comes home, what each refusal means, and what Auni can and can't do there.
---

# Polymarket

Polymarket is a prediction market on Polygon. A market is a question; each outcome is a share
that pays $1 if it turns out true and nothing if it doesn't, so a share's price between 0 and
$1 is the market's chance for that outcome. What follows is how it behaves in fact.

## Where the money sits

- **The Polymarket wallet.** The owner trades from a wallet of their own on Polygon that
  Polymarket's contracts derive from their address: a "deposit wallet", controlled only by
  their key, which Auni has Polymarket's relayer create on the first buy. Their shares and
  their Polymarket cash live there, not in their own wallet. `get_portfolio` shows both.
- **Its cash is pUSD**, Polymarket's own dollar, an ordinary token on Polygon backed one for
  one by USDC. A buy spends the pUSD already in the Polymarket wallet first. For the rest it
  takes USDC from the owner's wallet on Polygon and wraps it, in one batch the relayer sends,
  so the owner needs no gas there. Cash on another chain has to reach Polygon first.
- **Cash waits there until it is asked for.** What a sale or a payout pays stays in the
  Polymarket wallet as pUSD. It counts as Polygon cash for the next buy there, and it is the
  owner's to bring home whenever they like with `polymarket_withdraw` (below). Every order's
  card says so. Nothing is lost or held by anyone else while it waits.
- **The first buy leaves two lasting permissions**, which its card names: Polymarket's
  exchange may trade the cash in the Polymarket wallet, and Polymarket's redeemer may collect
  winnings into it when a market resolves. A first sale lets the exchange trade its shares.
  Each reaches only what is in the Polymarket wallet, never the owner's own.

## Finding a market: `polymarket_markets`

It searches open markets by theme and gives each market's question, its condition id and slug
(either names it to `polymarket_order`), each outcome with its price, the volume traded and
the end date. An event with many outcomes (who wins an election) is a set of markets, one per
outcome, each with its own Yes and No. In those, trade the named outcomes and leave "Other"
alone: what it covers changes as outcomes are added.

Read the market's rules, not only its title, before staking money on a question whose answer
could be argued: the rules decide how it resolves.

## Buying and selling: `polymarket_order`

- **It fills now or not at all.** The order goes to Polymarket's book as "fill what you can,
  cancel the rest". Nothing rests on the book, so nothing fills later out of sight. To trade at
  a price, set a watch on the outcome's price where a source that sees Polymarket is on, and
  order when it fires.
- **The worst price.** Auni walks the book to the price that fills the whole size, adds 1% of
  room, rounds out to the market's tick, and puts that on the card. The order is held to it. If the book has moved past it by the tap,
  nothing is sent; if only part fills inside it, the rest is cancelled and the fill is what is
  recorded. A thin book refuses a size it can't fill at all: use a smaller amount.
- **A buy** takes `amountUsd`, the dollars to spend. Polymarket refuses a buy under $1. Shares
  come in hundredths. Polymarket's fee comes on top, so the card's amount is the spend plus the
  most the fee can be.
- **A sale** takes exact `shares`, or `amountUsd` of shares at the best price bid, or neither to
  sell everything held. It can be any size. The fee comes out of what it pays.
- **The fee** is charged only on orders that take from the book, which every order of Auni's
  does: shares times the market's rate times price times (1 minus price). So it is largest at
  50 cents and falls to nothing near 0 and $1. Rates run from 0 on geopolitics markets to 0.07
  on crypto ones: at a rate of 0.05, a share bought at 50 cents costs 1.25 cents more (2.5% of
  the stake), and one at 90 cents under half a cent.
- **Settlement lags the fill.** An order matches on Polymarket's servers and settles on Polygon
  a little after. Shares just bought can be missing for a minute, so a sale straight after a
  buy can find nothing to sell: wait and try again. Some sports and short crypto markets hold
  an order briefly before matching it.
- **One move at a time.** Polymarket's relayer takes one transaction from a wallet at a time,
  so the owner's Polymarket moves queue. To close several positions together put them on one
  card with `propose_actions`.

## When a market resolves

Polymarket's markets resolve through UMA's oracle: someone proposes the outcome, and if nobody
disputes it within two hours it stands. A dispute starts it again, a second one sends it to a
vote, and a disputed market takes four to six days. Trading stops when a market resolves. A winning share is worth $1 and
a losing one nothing; a question with no clear answer can resolve 50-50 and pay 50 cents on
each side.

Polymarket pays out by itself: its redeemer burns the winning shares and pays the Polymarket
wallet in pUSD, with no move of Auni's and nothing to sell or collect. Auni reads the payout
from the chain and records it, so the position leaves the portfolio and its cash shows at
Polymarket. Losing shares are never redeemed, so Auni records a bet the market resolved against
as lost once it reads so, and those shares leave the portfolio too.

## Bringing cash home: `polymarket_withdraw`

- **What can come.** Cash only: the cash `get_portfolio` shows at Polymarket, to the cent. That
  is what sales and payouts paid and what a buy left unspent. Shares in a bet are not cash until
  they are sold or their market pays out, so to bring a bet's money home, sell it first and
  withdraw once that settles. Leave `amountUsd` out to bring all the cash.
- **Where it goes.** To the owner's own wallet on Polygon, as USDC, where it is Polygon cash
  like any other. The destination is never a choice: to send it on to another chain or to
  someone else, bring it home first, then use the move for that.
- **What it costs.** Polymarket pays its dollar out one for one as USDC.e, the bridged dollar
  that backs it, and a pool then swaps that for USDC and keeps a hundredth of a percent, a
  cent on $100. The two dollars trade within a few hundredths of a percent of each other, so
  about what leaves arrives. The card shows what arrives now and the least it accepts, a tenth
  of a percent under that; if the pool pays less by the tap, nothing is sent.
- **No gas.** Polymarket's relayer sends it, as one transaction that moves all of it or none,
  so the owner needs none of Polygon's coin. It leaves no permission behind.
- **It takes a moment.** Usually under a minute. Polymarket's wallet takes one transaction at
  a time, so it waits its turn behind a buy or a sale still going.
- **When to leave it there.** Cash in the Polymarket wallet pays for the next bet as it is.
  Brought home it is USDC, which a later bet has to turn back into Polymarket's dollar first.
  So bring home what the owner wants out, and leave what they mean to bet soon.

## When it refuses

A refusal fails the move in a sentence the owner also reads. What each means, and what next:

- **The region.** Polymarket decides by the internet address of the machine Auni runs on. From
  most places it blocks it takes no new bets but lets a bet held be sold and its cash come
  home; from a few it takes no orders at all. Auni asks Polymarket first, so from such a place
  `polymarket_order` makes no buy card, and no plan with one is made, which says so. Tell the
  owner plainly what Polymarket allows from there and what still works. These are Polymarket's
  rules and Auni keeps to them: never suggest a way round them, such as a VPN, a proxy, or
  running Auni on a computer somewhere else.
- **Nothing inside the card's price.** The book moved between the card and the tap. Offer a
  fresh card at the price now.
- **The book hasn't caught up with the wallet.** Polymarket's book keeps its own count of the
  wallet's cash and shares, which can trail a transfer by a moment. Any cash the buy moved in
  is in the Polymarket wallet. Try again; it will spend that first.
- **Too small.** A buy under $1, or under the market's own minimum. Raise it.
- **Restarting, paused, or too many requests.** Polymarket's side. It passes; try again
  shortly. When Polymarket says its exchange is paused, cancel-only or post-only, nothing was
  placed: the move fails and can be tried again once trading is back.
- **The relayer's quota.** Polymarket lets an Auni send only so many wallet transactions in a
  day, and each attempt counts, so don't retry in a loop. A sale of shares already approved
  needs no relayer and still works.
- **Not set up.** A buy, and bringing cash home, need Polymarket's relayer, which takes three
  builder keys the owner gets from their builder profile on polymarket.com. Without them
  markets can be read, and nothing that needs the relayer can go.
- **The pool pays less than the card showed, or is short.** The pool that swaps Polymarket's
  dollar for USDC moved, or holds too little USDC for this much. Nothing was sent. Offer a
  fresh card; when it is short, a smaller amount may go, or the same one later.
- **Polymarket has paused paying its dollar out.** Its side, and it passes. The cash is still
  in the Polymarket wallet.
- **A transaction in flight.** The wallet's last relayer transaction hasn't settled. Wait for
  the move before it to finish.
- **No answer.** If Polymarket never answered an order, or its relayer a withdrawal, it may
  have gone through. The move stays open instead of failing; read `get_portfolio` to see
  whether the shares, or the cash, are where it would have put them, and never send it again
  on a guess.

## What Auni can't do there

It can't leave an order resting at a price, split, merge or convert shares, redeem by hand
(Polymarket does that), bring cash home to any wallet but the owner's own, or trade a market
whose protocol it can't tell: Polymarket runs two side by side, and Auni refuses one its ids
and its book disagree about. A specialist set to act on its own may buy and sell predictions
at the market within its pot without asking.
