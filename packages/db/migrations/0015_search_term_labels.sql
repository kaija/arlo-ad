CREATE TYPE "public"."search_intent" AS ENUM('purchase', 'research', 'support', 'navigational', 'competitor', 'jobs', 'free_or_diy', 'unrelated');--> statement-breakpoint
CREATE TABLE "g_search_term_labels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"term_hash" text NOT NULL,
	"term" text NOT NULL,
	"profile_version" integer NOT NULL,
	"intent" "search_intent" NOT NULL,
	"relevant" boolean NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"reason" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "g_search_term_labels_key" UNIQUE("account_id","term_hash","profile_version"),
	CONSTRAINT "g_search_term_labels_confidence" CHECK ("g_search_term_labels"."confidence" between 0 and 1)
);
--> statement-breakpoint
ALTER TABLE "g_search_term_labels" ADD CONSTRAINT "g_search_term_labels_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_search_term_labels" ADD CONSTRAINT "g_search_term_labels_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;