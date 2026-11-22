ALTER TABLE "owner" ADD COLUMN "starting_points" jsonb;--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "starting_points_at" timestamp (3) with time zone;