ALTER TABLE "actions" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "run" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- How far each running move had got, said by what the code before this read it from.
UPDATE "actions" SET "phase" = CASE
  WHEN "started_at" IS NULL THEN 'queued'
  WHEN "error" = 'Its money moved, but what it bought or sold isn''t recorded yet.' THEN 'needs_owner'
  WHEN "details" ? 'lands' THEN 'landing'
  WHEN "error" IS NOT NULL THEN 'unsure'
  ELSE 'sending' END
WHERE "status" = 'running';--> statement-breakpoint
-- What a run wrote into the card's details moves to its own column.
UPDATE "actions" SET
  "run" = (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM jsonb_each("details")
           WHERE key IN ('lands', 'landsUnits', 'delivered', 'returnedUsd')),
  "details" = "details" - 'lands' - 'landsUnits' - 'delivered' - 'returnedUsd'
WHERE "details" ?| array['lands', 'landsUnits', 'delivered', 'returnedUsd'];--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_phase_check" CHECK ("actions"."phase" in ('queued', 'sending', 'landing', 'unsure', 'needs_owner'));--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_running_phase_check" CHECK (("actions"."status" = 'running') = ("actions"."phase" is not null));
