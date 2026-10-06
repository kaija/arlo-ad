CREATE TABLE "monitor_firings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"monitor_rule_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"changeset_id" uuid,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"campaign_entity_id" uuid,
	"spec" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"cooldown_minutes" integer DEFAULT 360 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_rules_cooldown" CHECK ("monitor_rules"."cooldown_minutes" between 0 and 10080)
);
--> statement-breakpoint
ALTER TABLE "monitor_firings" ADD CONSTRAINT "monitor_firings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_firings" ADD CONSTRAINT "monitor_firings_monitor_rule_id_monitor_rules_id_fk" FOREIGN KEY ("monitor_rule_id") REFERENCES "public"."monitor_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_firings" ADD CONSTRAINT "monitor_firings_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_firings" ADD CONSTRAINT "monitor_firings_changeset_id_changesets_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."changesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_rules" ADD CONSTRAINT "monitor_rules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_rules" ADD CONSTRAINT "monitor_rules_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_rules" ADD CONSTRAINT "monitor_rules_campaign_entity_id_entities_id_fk" FOREIGN KEY ("campaign_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_rules" ADD CONSTRAINT "monitor_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_firings_rule_entity_fired_idx" ON "monitor_firings" USING btree ("monitor_rule_id","entity_id","fired_at");--> statement-breakpoint
CREATE INDEX "monitor_rules_account_idx" ON "monitor_rules" USING btree ("account_id");