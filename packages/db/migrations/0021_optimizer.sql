CREATE TABLE "g_budget_simulations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"points" jsonb NOT NULL,
	"fetched_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "g_budget_simulations_campaign_key" UNIQUE("campaign_id")
);
--> statement-breakpoint
CREATE TABLE "optimizer_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"inputs" jsonb NOT NULL,
	"plan" jsonb NOT NULL,
	"max_change_pct" numeric(6, 4) NOT NULL,
	"min_conversions" integer NOT NULL,
	"changeset_id" uuid,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "g_budget_simulations" ADD CONSTRAINT "g_budget_simulations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_budget_simulations" ADD CONSTRAINT "g_budget_simulations_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_budget_simulations" ADD CONSTRAINT "g_budget_simulations_campaign_id_entities_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimizer_runs" ADD CONSTRAINT "optimizer_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimizer_runs" ADD CONSTRAINT "optimizer_runs_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimizer_runs" ADD CONSTRAINT "optimizer_runs_changeset_id_changesets_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."changesets"("id") ON DELETE no action ON UPDATE no action;