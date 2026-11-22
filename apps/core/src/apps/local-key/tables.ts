import { sql } from "drizzle-orm";
import { bigint, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { actions } from "../../db/schema.ts";

// local-key's own table. An app's tables live in its folder (tables.ts), named "<id>_<name>"
// from now on; drizzle-kit reads them beside core's schema, into the one migration folder.

const TIMESTAMPTZ = { withTimezone: true, mode: "date", precision: 3 } as const;

// Every transaction a wallet that holds its own keys signed, written before it is broadcast, so
// a retry or a crash sends the same bytes again rather than signing a second send. Its id is
// the walletTxId the action keeps.
export const signedTxs = pgTable(
  "signed_txs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id),
    chain: text("chain").notNull(),
    address: text("address").notNull(),
    // An EVM send's nonce; null on Solana, where a blockhash's expiry bounds a send instead.
    nonce: bigint("nonce", { mode: "number" }),
    raw: text("raw").notNull(),
    hash: text("hash").notNull(),
    // The node refused it, so it never went and its nonce is free again.
    rejectedAt: timestamp("rejected_at", TIMESTAMPTZ),
    // A stuck EVM send re-signed at a higher fee (see local-key/evm.ts replaceStuck): the same
    // call at the same nonce, so at most one of them lands. `replaces` is the send it took over
    // from, and `replacedAt` marks the one taken over.
    replaces: uuid("replaces"),
    replacedAt: timestamp("replaced_at", TIMESTAMPTZ),
    createdAt: timestamp("created_at", TIMESTAMPTZ).defaultNow().notNull(),
  },
  (table) => [
    // Sends from one account take turns picking a nonce (see local-key/evm.ts); this makes sure
    // one live send holds each.
    uniqueIndex("signed_txs_nonce_idx")
      .on(table.chain, table.address, table.nonce)
      .where(
        sql`${table.nonce} is not null and ${table.rejectedAt} is null and ${table.replacedAt} is null`,
      ),
  ],
);

export type SignedTxRow = typeof signedTxs.$inferSelect;
