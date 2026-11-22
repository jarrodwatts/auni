ALTER TABLE "actions" DROP CONSTRAINT "actions_status_check";--> statement-breakpoint
ALTER TABLE "actions" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_status_check" CHECK ("actions"."status" in ('awaiting_permission', 'running', 'done', 'failed', 'cancelled', 'replaced'));