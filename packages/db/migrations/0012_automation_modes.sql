CREATE TYPE "public"."automation_mode" AS ENUM('off', 'shadow', 'live');--> statement-breakpoint
CREATE TABLE "automation_modes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"feature" "automation_feature" NOT NULL,
	"mode" "automation_mode" NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_modes_account_feature_key" UNIQUE("account_id","feature")
);
--> statement-breakpoint
ALTER TABLE "automation_modes" ADD CONSTRAINT "automation_modes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_modes" ADD CONSTRAINT "automation_modes_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_modes" ADD CONSTRAINT "automation_modes_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;