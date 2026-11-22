ALTER TABLE "owner" ADD COLUMN "look" text;--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "x_handle" text;--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "watched_wallets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "profile_summary" text;--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "profile_signals" jsonb;--> statement-breakpoint
ALTER TABLE "owner_sessions" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "owner_sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "owner_sessions" ADD COLUMN "last_seen_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "owner_sessions" ADD COLUMN "browser_issued" boolean DEFAULT false NOT NULL;