-- Existing actions are numbered in the order they were made, not the order Postgres stores them.
ALTER TABLE "actions" ADD COLUMN "seq" bigint;--> statement-breakpoint
UPDATE "actions" SET "seq" = n.n FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS n FROM "actions") n WHERE "actions"."id" = n."id";--> statement-breakpoint
ALTER TABLE "actions" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "actions" ALTER COLUMN "seq" ADD GENERATED ALWAYS AS IDENTITY (sequence name "actions_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
SELECT setval('actions_seq_seq', coalesce(max("seq"), 1), max("seq") IS NOT NULL) FROM "actions";
