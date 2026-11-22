CREATE TABLE "first_looks" (
	"place" text PRIMARY KEY NOT NULL,
	"looked_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "other_tokens" DROP CONSTRAINT "other_tokens_kept_check";--> statement-breakpoint
ALTER TABLE "other_tokens" ADD CONSTRAINT "other_tokens_kept_check" CHECK ("other_tokens"."kept_at" is not null or "other_tokens"."kept_block" is null);