CREATE TABLE "sync_state" (
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"job" text NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_state_pk" PRIMARY KEY("account_id","job"),
	CONSTRAINT "sync_state_failures_non_negative" CHECK ("sync_state"."consecutive_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;