CREATE TABLE "app_troubles" (
	"app" text NOT NULL,
	"work" text NOT NULL,
	"kind" text NOT NULL,
	"said" text NOT NULL,
	"since" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"times" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "app_troubles_app_work_pk" PRIMARY KEY("app","work")
);
