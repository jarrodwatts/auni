ALTER TABLE "fills" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "default_model_selection" jsonb;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "act_mode" text DEFAULT 'ask_first' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "budget_usd" numeric(14, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "model_selection" jsonb;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "pinned_at" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "threads" t
SET
  "act_mode" = CASE WHEN s."status" = 'active' THEN s."act_mode" ELSE 'ask_first' END,
  "budget_usd" = CASE WHEN s."status" = 'active' THEN s."pot_usd" ELSE '0.00' END,
  "notes" = COALESCE(s."notes", s."report"),
  "title" = COALESCE(t."title", s."name")
FROM "specialists" s
WHERE t."specialist_id" = s."id";--> statement-breakpoint
UPDATE "fills" f
SET "thread_id" = COALESCE(
  (SELECT a."thread_id" FROM "actions" a WHERE a."id" = f."action_id"),
  (SELECT t."id" FROM "threads" t WHERE t."specialist_id" = f."specialist_id" LIMIT 1)
)
WHERE f."action_id" IS NOT NULL OR f."specialist_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "value_snapshots" WHERE "specialist_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "actions_specialist_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "automations_specialist_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "fills_specialist_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "threads_specialist_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "value_snapshots_specialist_taken_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "fills_venue_ref_idx";--> statement-breakpoint
ALTER TABLE "actions" DROP CONSTRAINT IF EXISTS "actions_specialist_id_specialists_id_fk";--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT IF EXISTS "automations_specialist_id_specialists_id_fk";--> statement-breakpoint
ALTER TABLE "fills" DROP CONSTRAINT IF EXISTS "fills_specialist_id_specialists_id_fk";--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT IF EXISTS "threads_specialist_id_specialists_id_fk";--> statement-breakpoint
ALTER TABLE "value_snapshots" DROP CONSTRAINT IF EXISTS "value_snapshots_specialist_id_specialists_id_fk";--> statement-breakpoint
ALTER TABLE "actions" DROP COLUMN "specialist_id";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "specialist_id";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "thesis";--> statement-breakpoint
ALTER TABLE "fills" DROP COLUMN "specialist_id";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "specialist_id";--> statement-breakpoint
ALTER TABLE "value_snapshots" DROP COLUMN "specialist_id";--> statement-breakpoint
DROP TABLE IF EXISTS "specialist_updates" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "specialists" CASCADE;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fills_thread_idx" ON "fills" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "value_snapshots_taken_idx" ON "value_snapshots" USING btree ("taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fills_venue_ref_idx" ON "fills" USING btree ("venue_ref",coalesce("thread_id", '00000000-0000-0000-0000-000000000000'));--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_act_mode_check" CHECK ("threads"."act_mode" in ('ask_first', 'within_limits'));
