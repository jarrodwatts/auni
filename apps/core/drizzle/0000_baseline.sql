CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid,
	"specialist_id" uuid,
	"proposal_id" uuid,
	"summary" text NOT NULL,
	"amount_usd" numeric(14, 2) NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"venue" text,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"terms" jsonb,
	"txs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"failure_kind" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"previous_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp (3) with time zone,
	"step_up_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actions_status_check" CHECK ("actions"."status" in ('proposed', 'awaiting_permission', 'running', 'done', 'failed', 'cancelled', 'replaced'))
);
--> statement-breakpoint
CREATE TABLE "arrival_cursors" (
	"chain" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"resume" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arrivals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"tx_hash" text NOT NULL,
	"position" text NOT NULL,
	"instrument" text NOT NULL,
	"base_units" numeric(78, 0) NOT NULL,
	"decimals" integer NOT NULL,
	"usd_value" numeric(14, 2),
	"symbol" text,
	"counterparty" text,
	"kind" text NOT NULL,
	"action_id" uuid,
	"at" timestamp (3) with time zone NOT NULL,
	"block" bigint NOT NULL,
	"counts_from" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arrivals_kind_check" CHECK ("arrivals"."kind" in ('own_move', 'landing', 'payout', 'external_out', 'deposit'))
);
--> statement-breakpoint
CREATE TABLE "automation_fires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"storyline_id" text,
	"happened_at" timestamp (3) with time zone NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"verdict" text,
	"reason" text,
	"briefed_at" timestamp (3) with time zone,
	"message_id" uuid,
	"outcome" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_fires_verdict_check" CHECK ("automation_fires"."verdict" in ('quiet', 'wake', 'brief', 'note'))
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"specialist_id" uuid,
	"source" text NOT NULL,
	"source_ref" text,
	"lease_until" timestamp (3) with time zone,
	"condition" jsonb NOT NULL,
	"description" text NOT NULL,
	"note" text NOT NULL,
	"thesis" boolean DEFAULT false NOT NULL,
	"repeat" text,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"last_fired_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_status_check" CHECK ("automations"."status" in ('active', 'paused', 'triggered', 'expired', 'cancelled', 'failed', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "channel_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"ref" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"action_id" uuid,
	"proposal_id" uuid,
	"question" jsonb,
	"grant_hash" text,
	"grant_expires_at" timestamp (3) with time zone,
	"card_digest" text,
	"decided_at" timestamp (3) with time zone,
	"shown" text,
	"open" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_deliveries_grant_hash_unique" UNIQUE("grant_hash")
);
--> statement-breakpoint
CREATE TABLE "channel_links" (
	"channel" text PRIMARY KEY NOT NULL,
	"owner" text,
	"chat" text,
	"pairing_hash" text,
	"pairing_expires_at" timestamp (3) with time zone,
	"paired_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"specialist_id" uuid,
	"instrument" text NOT NULL,
	"chain" text NOT NULL,
	"side" text NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"usd_value" numeric(14, 2) NOT NULL,
	"venue_ref" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fills_side_check" CHECK ("fills"."side" in ('buy', 'sell'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"data" jsonb NOT NULL,
	"lanes" text[] DEFAULT '{}' NOT NULL,
	"run_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	"outcome" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "jobs_key_unique" UNIQUE("key"),
	CONSTRAINT "jobs_outcome_check" CHECK ("jobs"."outcome" in ('done', 'failed', 'interrupted', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"supersedes_id" uuid,
	"origin" text DEFAULT 'human' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant')),
	CONSTRAINT "messages_origin_check" CHECK ("messages"."origin" in ('human', 'automation'))
);
--> statement-breakpoint
CREATE TABLE "other_tokens" (
	"chain" text NOT NULL,
	"instrument" text NOT NULL,
	"seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"kept_at" timestamp (3) with time zone,
	"kept_usd" numeric(14, 2),
	"kept_block" bigint,
	CONSTRAINT "other_tokens_chain_instrument_pk" PRIMARY KEY("chain","instrument"),
	CONSTRAINT "other_tokens_kept_check" CHECK (("other_tokens"."kept_at" is null) = ("other_tokens"."kept_block" is null))
);
--> statement-breakpoint
CREATE TABLE "owner" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"brief_at" text DEFAULT '08:00',
	"last_brief_at" timestamp (3) with time zone,
	"home_channel" text,
	"last_channel" text,
	"activity_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_one_row_check" CHECK ("owner"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "owner_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "owner_sessions_kind_check" CHECK ("owner_sessions"."kind" in ('pairing', 'session'))
);
--> statement-breakpoint
CREATE TABLE "passkey_challenges" (
	"challenge" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"action_id" uuid,
	"card_digest" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "passkey_challenges_purpose_check" CHECK ("passkey_challenges"."purpose" in ('register', 'allow', 'reveal_keys'))
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint NOT NULL,
	"transports" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signed_txs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"nonce" bigint,
	"raw" text NOT NULL,
	"hash" text NOT NULL,
	"rejected_at" timestamp (3) with time zone,
	"replaces" uuid,
	"replaced_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_cursors" (
	"source" text PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"saved_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specialist_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"specialist_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"undone_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specialists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"theme" text,
	"pot_usd" numeric(14, 2) NOT NULL,
	"act_mode" text DEFAULT 'ask_first' NOT NULL,
	"pulse" text,
	"notes" text,
	"report" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp (3) with time zone,
	CONSTRAINT "specialists_kind_check" CHECK ("specialists"."kind" in ('take', 'role')),
	CONSTRAINT "specialists_status_check" CHECK ("specialists"."status" in ('active', 'retired')),
	CONSTRAINT "specialists_act_mode_check" CHECK ("specialists"."act_mode" in ('ask_first', 'within_limits'))
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"specialist_id" uuid,
	"title" text,
	"awaiting_deposit_since" timestamp (3) with time zone,
	"expected_tokens" text[] DEFAULT '{}' NOT NULL,
	"settled_at" timestamp (3) with time zone,
	"turn_started_at" timestamp (3) with time zone,
	"replied_at" timestamp (3) with time zone,
	"read_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "value_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"specialist_id" uuid,
	"usd_value" numeric(14, 2) NOT NULL,
	"cash_usd" numeric(14, 2),
	"holdings" jsonb,
	"taken_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_specialist_id_specialists_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arrivals" ADD CONSTRAINT "arrivals_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_fires" ADD CONSTRAINT "automation_fires_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_fires" ADD CONSTRAINT "automation_fires_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_specialist_id_specialists_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_deliveries" ADD CONSTRAINT "channel_deliveries_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_deliveries" ADD CONSTRAINT "channel_deliveries_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_specialist_id_specialists_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_supersedes_id_messages_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_challenges" ADD CONSTRAINT "passkey_challenges_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_txs" ADD CONSTRAINT "signed_txs_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_updates" ADD CONSTRAINT "specialist_updates_specialist_id_specialists_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_updates" ADD CONSTRAINT "specialist_updates_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_specialist_id_specialists_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_snapshots" ADD CONSTRAINT "value_snapshots_specialist_id_specialists_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actions_thread_idx" ON "actions" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "actions_proposal_idx" ON "actions" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "actions_specialist_status_idx" ON "actions" USING btree ("specialist_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "arrivals_transfer_idx" ON "arrivals" USING btree ("chain","tx_hash","position");--> statement-breakpoint
CREATE INDEX "arrivals_counts_from_idx" ON "arrivals" USING btree ("counts_from");--> statement-breakpoint
CREATE INDEX "automation_fires_automation_idx" ON "automation_fires" USING btree ("automation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_fires_event_idx" ON "automation_fires" USING btree ("automation_id","event_id");--> statement-breakpoint
CREATE INDEX "automations_thread_idx" ON "automations" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "automations_specialist_idx" ON "automations" USING btree ("specialist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_source_ref_idx" ON "automations" USING btree ("source","source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_deliveries_ref_unique" ON "channel_deliveries" USING btree ("channel","ref");--> statement-breakpoint
CREATE INDEX "channel_deliveries_action_idx" ON "channel_deliveries" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "channel_deliveries_proposal_idx" ON "channel_deliveries" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "channel_deliveries_open_idx" ON "channel_deliveries" USING btree ("open") WHERE "channel_deliveries"."open";--> statement-breakpoint
CREATE INDEX "fills_action_idx" ON "fills" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "fills_specialist_idx" ON "fills" USING btree ("specialist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fills_venue_ref_idx" ON "fills" USING btree ("venue_ref",coalesce("specialist_id", '00000000-0000-0000-0000-000000000000'));--> statement-breakpoint
CREATE INDEX "jobs_open_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signed_txs_nonce_idx" ON "signed_txs" USING btree ("chain","address","nonce") WHERE "signed_txs"."nonce" is not null and "signed_txs"."rejected_at" is null and "signed_txs"."replaced_at" is null;--> statement-breakpoint
CREATE INDEX "specialist_updates_specialist_idx" ON "specialist_updates" USING btree ("specialist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_specialist_unique" ON "threads" USING btree ("specialist_id") WHERE "threads"."specialist_id" is not null;--> statement-breakpoint
CREATE INDEX "value_snapshots_specialist_taken_idx" ON "value_snapshots" USING btree ("specialist_id","taken_at");--> statement-breakpoint
INSERT INTO "owner" DEFAULT VALUES;