# Adding a wallet

A wallet app holds the owner's wallets (one EVM address, one Solana address) and signs for
them. Core uses exactly one: the app `WALLET` names, or else the one whose provider sets
`byDefault` (`theWallet()` in `registry.ts`). The rest of core reaches it only through
`../money/wallets.ts` (`walletAddresses`, `signerFor`, `paysOwnGas` and the rest).

Two wallets ship:

- `local-key/` (the default): keys kept on the owner's machine, which Auni signs with itself.
  It is the example below.
- `privy/` (`WALLET=privy`): server wallets in the owner's own Privy app, signed for with their
  `PRIVY_AUTHORIZATION_KEY`, with Privy's gas sponsorship where their app has it.

```
  executeAction (money/actions.ts)       a move the owner allowed, still matching its card
        |
        v
  signerFor(options) (money/wallets.ts) -> theWallet() (registry.ts) -> the app's provider
        |
        v
  signer({ actionId, attempt, onSent }) -> Signer: sendEvmTransaction, signEvmTypedData,
                                           sendSolanaTransaction
```

## Steps

1. Make `apps/<id>/` with `about.ts` and `index.ts`, as every app has (`AGENTS.md`). A
   wallet's `about.ts` needs only `id` and `name`; local-key's `index.ts` is one line:
   `defineApp({ about, wallet: localKeyWallet })`.
2. Write the provider, a `WalletProvider` (`contract.ts`). `localKeyWalletIn` in
   `local-key/wallet.ts` is the whole shape in one place; `privyWallet` at the end of
   `privy/wallet.ts` is the other:
   - `addresses()`: the owner's EVM and Solana addresses, both null until there is a wallet:
     asking never makes one (null too for a kind it holds no key of). The sweep and readings ask
     each minute before reading the wallet (`hasWallet`), so keep it cheap once there is one.
     Local-key: read from its store until found, then held in memory.
   - `create()`: makes the owner's wallet as they send their first take (`POST /setup/done`),
     once: throw `WalletExists` (`contract.ts`) when there is one. Local-key generates its keys under
     a database lock, so two asks at once make one; Privy makes its two server wallets.
   - `bring` (optional): a private field (`../private-fields.ts`) for keys the owner already holds,
     such as an auni.io export: `check` says the addresses they sign for and what's worth knowing
     (another wallet's EIP-7702 code, who else holds a copy), `accept` takes them in, refusing
     with `PrivateFieldRefused` while there is a wallet. Local-key's is `local-key/bring.ts`.
     Replacing a wallet's keys once there is one is out for now.
   - `addMissing()` (optional): for a wallet brought with one key alone, makes the other beside
     it, never changing the one it holds (Settings, `POST /me/wallet/missing`). Without it a
     wallet with no Solana key can't gain one, and every Solana move says so.
   - `bringSolana` (optional): a private field for a Solana key the owner already holds, added
     beside an EVM key held alone and refused once there is a Solana key. Core gives it its id
     and offers it only to a request with the owner's proof (`../money/wallets.ts`), then sweeps.
   - `sponsored(chain)` (optional): a sponsor, not the wallet, pays the network's fees there (an
     EVM chain by its id, or `"solana"`, with the rent of accounts a move opens). It is the one
     thing core asks about fees, through `paysOwnGas` in `../money/wallets.ts`. Where the wallet
     pays, a preview checks it holds enough of the chain's coin (`ownGas`, see `asSent`) and
     its card buys the coin first where it doesn't (`../money/fee-coin.ts`); on
     Solana `simulateSolana` reads what it's short, which `../money/sol-top-up.ts` buys first,
     through Relay from its USDC on Monad (a sponsored wallet buys it from its Solana USDC in a
     swap its sponsor pays for). Absent, as in local-key: the wallet pays its own everywhere. Privy:
     sponsored everywhere but Ethereum.
   - `signer({ actionId, attempt, onSent })`: a `Signer` (`../money/recipe.ts`) that sends
     EVM and Solana transactions and signs typed data for this one move. A list of EVM calls
     goes as one transaction, all or nothing, since its card judged it as one; a wallet that
     can't send it so refuses it before signing.
   - `asSent(chainId, owner, txs)` (optional): the one transaction `signer` would send for those
     calls, said with nothing signed: where it goes, its data, the coin it carries, and the
     account code the send delegates the address to, when it does. `../money/gas.ts` asks the
     chain what that very transaction costs: its gas limit (`gasLimit`, a quarter over the
     node's estimate), what the wallet must hold for it (`ownGas`, before a card is shown) and
     the card's network fee. A wallet that pays its own fees calls `assertOwnGas` before it
     signs, and signs with `gasLimit`, so the card, the check and the send are one figure on
     every chain, Monad included, which charges for the whole limit. Absent: Auni can't say what
     a send costs, and only the node refuses one the wallet can't pay for.
   - `sendStatus(walletTxId)`: a send kept by the wallet's own id for it (`KeptTx.walletTxId`)
     that the chain can't answer for yet, as the wallet tells it now: its hash, `"pending"`, or
     `"failed"` for good. `../money/reconcile.ts` asks it to settle moves whose answer was lost.
     An id it never made (another wallet's) is `"pending"`.
   - `resend()` (optional): delivers again whatever it signed that no node answered for, the
     same bytes. Core's job runner calls it as Auni starts, so a send cut off by a crash between
     signing and broadcasting goes out, signed once. Only a wallet that broadcasts itself needs
     it; local-key resends the journalled sends of moves still running.
   - `revealKeys()`: the owner's private keys, shown only behind the owner's proof (first run's backup
     and Settings, `POST /me/keys` in `../routes/me.ts`); throw `NoWallet` while there's none.
   - `keptHere` (optional): where this machine keeps the keys, in words and never the keys
     (`auni doctor` says it), and `remove()`, which deletes them for good: only `auni uninstall`
     calls it, once the owner has typed that they mean it. Absent where the keys aren't on this
     machine, as with Privy.
   - `byDefault: true` only if it replaces local-key as the default; `apps.test.ts` checks
     exactly one app sets it.
3. Declare its settings in `about.settings`, each of kind `file`: what a wallet reads decides who
   holds the owner's money, so the app shows it and only the settings file changes it. Read each
   where it's used with `setting(about, ...)`, and throw a plain error when the wallet is chosen
   but unset, as `privy/wallet.ts` does for `PRIVY_AUTHORIZATION_KEY`. Add a line for each to
   `apps/core/.env.example`.
4. Run `pnpm gen`, then the checks in the root `AGENTS.md`. Choose it with `WALLET=<id>`.

## What a signer must do

- Sign only what core hands it. Core calls `signer` only from `executeAction`, for a move the
  owner allowed and that still matches its card. Nothing else may reach a key.
- Never log a key, put one in an error, or let one reach the agent's box. Only `revealKeys` hands
  one out.
- Never sign typed data that would let someone act as the wallet itself. Local-key refuses a
  document whose verifier is the account or its delegation manager (`signEvmTypedData`).
- Call `onSent` for every send the moment it goes out, before waiting on it, so a failure halfway
  still leaves an honest record. A wallet that keeps its own record of sends to send again
  passes its database transaction as `onSent(tx, within)`, so both records commit together.
  Then wait until it lands before returning, so a recipe can chain an approval into the call
  that spends it.
- Never send twice. Privy dedupes on a key made of `actionId`, `attempt` and a counter. Local-key
  journals the signed bytes (`signed_txs`) before broadcasting, and only ever sends those bytes
  again, but for a stuck EVM send, re-signed at a higher fee at its own nonce (below), so at most
  one of the two can land. A send that may have gone throws `MayHaveSent` so core settles it from
  the chain instead of failing it; one that surely didn't throws a plain error.

## How local-key does it

- **Keys** (`local-key/keys.ts`) live in the OS keychain where one answers, otherwise in
  `$AUNI_HOME/wallet-keys.json` (mode 0600). Once that file exists it says
  where they are, so a run where the keychain is out of reach fails instead of making new keys.
  Only `~/.auni` puts new keys in the keychain, in an entry named after the folder and recorded
  in its file: an entry outlives its folder, and any other `AUNI_HOME` (a test, a demo, a second
  Auni) keeps them in its file. On Linux only a Secret Service counts: the library's fallback,
  the kernel's keyring, is memory that a reboot clears. Keys are only ever added, never one over
  another, under a database lock (`withKeysLocked`): by `create` or `bring`, and by `addMissing`,
  which replaces the file whole by a rename.
- **EVM** (`local-key/evm.ts`): one call goes as built. A list goes as one call from the account
  to itself, which MetaMask's audited EIP7702StatelessDeleGator runs all or nothing; the first
  such send carries the EIP-7702 authorization that delegates the account to it, and a chain
  without the DeleGator refuses before signing. `asSent` says that transaction, so its gas
  limit is asked for with no signature: the node estimates it as if the account already ran the
  DeleGator. On Monad a delegated account keeps 10 MON it can't spend (`RESERVES` in
  `../money/chains.ts`).
- **Nonces**: sends from one account take turns (`inTurn` in `../db/client.ts`, a Postgres lock
  held across commits) from picking a nonce until a node answers, so a nonce a node refused is
  free again before the next send picks one. In its turn a send first sends again the journalled
  ones the chain hasn't mined (a refusal frees theirs too), then takes the lowest nonce from the
  chain's pending count that no live journalled send holds. A send's journal row and its record
  on the action commit as one write (`within` in `onSent`), so a crash can't leave a send its
  action knows nothing of. A nonce taken by another transaction makes `sendStatus` say failed.
- **A stuck send** (`replaceStuck`): one unmined past 3 minutes whose fee cap is under today's
  would hold every later nonce back, so in the account's turn (before a send picks its nonce, in
  `resend()`, and in `sendStatus`) it is signed again: the same call, gas and authorization at
  the same nonce, each fee the higher of today's and an eighth over its own (nodes ask a tenth).
  The new row is journalled with `replaces` as the old one is marked `replaced_at`, in one write,
  before it goes; a node refusing it gives the nonce back to the old one. It's skipped when the
  wallet can't pay the higher fee, and after 3 replacements. `sendStatus` reads a receipt for
  any of them as the move's, with that hash, which reconcile then keeps.
- **Solana** (`local-key/solana.ts`): signs beside any signature already on the transaction,
  pays its own fee and rent, and journals before sending. `sendStatus` says failed once the
  blockhash has expired. A move short of SOL buys it first with the wallet's USDC on Monad
  (`../money/sol-top-up.ts`), as its card shows as SOL for fees.

Tests: `privy/wallet.test.ts`, `local-key/*.test.ts` (`evm.fork.db.test.ts` runs against an anvil
fork of Monad when `AUNI_FORK_RPC` is set). Recipe tests stand a local key in for a wallet with
`walletsFor` in `../test/wallets.ts`.
