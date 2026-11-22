ALTER TABLE "actions" ADD COLUMN "ended_at" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "actions" SET "ended_at" = "updated_at" WHERE "status" IN ('done', 'failed') OR "phase" IN ('landing', 'unsure', 'needs_owner');
