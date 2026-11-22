ALTER TABLE "owner" ADD COLUMN "brief" jsonb DEFAULT '{"every":"day","at":"08:00"}'::jsonb;--> statement-breakpoint
UPDATE "owner" SET "brief" = CASE WHEN "brief_at" IS NULL THEN NULL ELSE jsonb_build_object('every', 'day', 'at', "brief_at") END;--> statement-breakpoint
ALTER TABLE "owner" DROP COLUMN "brief_at";
