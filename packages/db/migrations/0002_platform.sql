CREATE TYPE "public"."entity_kind" AS ENUM('account', 'campaign', 'ad_group', 'keyword', 'shared_set', 'campaign_budget');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('google_ads');--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"timezone" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_accounts_org_platform_external_id_key" UNIQUE("org_id","platform","external_id"),
	CONSTRAINT "ad_accounts_currency_iso" CHECK ("ad_accounts"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "change_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"user_email" text,
	"client_type" text,
	"resource_type" text,
	"resource_name" text,
	"changed_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"old" jsonb,
	"new" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_events_account_external_id_key" UNIQUE("account_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "entity_kind" NOT NULL,
	"external_id" text NOT NULL,
	"parent_id" uuid,
	"name" text,
	"status" text,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_account_kind_external_id_key" UNIQUE("account_id","kind","external_id"),
	CONSTRAINT "entities_id_account_kind_key" UNIQUE("id","account_id","kind")
);
--> statement-breakpoint
CREATE TABLE "entity_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"budget_micros" bigint,
	"status" text,
	"bid_strategy" text,
	"bid_target" numeric(20, 6),
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_snapshots_entity_captured_at_key" UNIQUE("entity_id","captured_at")
);
--> statement-breakpoint
CREATE TABLE "g_audience_metrics" (
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_list_id" text NOT NULL,
	"user_list_name" text,
	"targeting_mode" text,
	"date" date NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"conversions" numeric(20, 6) DEFAULT 0 NOT NULL,
	"conv_value" numeric(20, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "g_audience_metrics_pk" PRIMARY KEY("campaign_id","user_list_id","date")
);
--> statement-breakpoint
CREATE TABLE "g_conversion_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"category" text,
	"primary" boolean DEFAULT false NOT NULL,
	"last_conversion_at" timestamp with time zone,
	"ec_diagnostics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "g_conversion_actions_account_external_id_key" UNIQUE("account_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "g_search_terms" (
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"ad_group_id" uuid NOT NULL,
	"term" text NOT NULL,
	"date" date NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"conversions" numeric(20, 6) DEFAULT 0 NOT NULL,
	"conv_value" numeric(20, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "g_search_terms_pk" PRIMARY KEY("ad_group_id","term","date")
);
--> statement-breakpoint
CREATE TABLE "ga4_daily" (
	"org_id" uuid NOT NULL,
	"property_id" text NOT NULL,
	"date" date NOT NULL,
	"source_medium" text NOT NULL,
	"sessions" bigint DEFAULT 0 NOT NULL,
	"conversions" numeric(20, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ga4_daily_pk" PRIMARY KEY("org_id","property_id","date","source_medium")
);
--> statement-breakpoint
CREATE TABLE "metrics_daily" (
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"level" "entity_kind" NOT NULL,
	"date" date NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"conversions" numeric(20, 6) DEFAULT 0 NOT NULL,
	"conv_value" numeric(20, 6) DEFAULT 0 NOT NULL,
	"search_is" numeric(6, 5),
	"lost_is_budget" numeric(6, 5),
	"lost_is_rank" numeric(6, 5),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metrics_daily_pk" PRIMARY KEY("entity_id","date")
);
--> statement-breakpoint
CREATE TABLE "metrics_hourly" (
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"level" "entity_kind" NOT NULL,
	"date" date NOT NULL,
	"hour" smallint NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"conversions" numeric(20, 6) DEFAULT 0 NOT NULL,
	"conv_value" numeric(20, 6) DEFAULT 0 NOT NULL,
	"search_is" numeric(6, 5),
	"lost_is_budget" numeric(6, 5),
	"lost_is_rank" numeric(6, 5),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metrics_hourly_pk" PRIMARY KEY("entity_id","date","hour"),
	CONSTRAINT "metrics_hourly_hour_range" CHECK ("metrics_hourly"."hour" between 0 and 23)
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_snapshots" ADD CONSTRAINT "entity_snapshots_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_snapshots" ADD CONSTRAINT "entity_snapshots_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_audience_metrics" ADD CONSTRAINT "g_audience_metrics_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_audience_metrics" ADD CONSTRAINT "g_audience_metrics_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_audience_metrics" ADD CONSTRAINT "g_audience_metrics_campaign_id_entities_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_conversion_actions" ADD CONSTRAINT "g_conversion_actions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_conversion_actions" ADD CONSTRAINT "g_conversion_actions_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_search_terms" ADD CONSTRAINT "g_search_terms_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_search_terms" ADD CONSTRAINT "g_search_terms_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_search_terms" ADD CONSTRAINT "g_search_terms_campaign_id_entities_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g_search_terms" ADD CONSTRAINT "g_search_terms_ad_group_id_entities_id_fk" FOREIGN KEY ("ad_group_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga4_daily" ADD CONSTRAINT "ga4_daily_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_entity_fk" FOREIGN KEY ("entity_id","account_id","level") REFERENCES "public"."entities"("id","account_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_hourly" ADD CONSTRAINT "metrics_hourly_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_hourly" ADD CONSTRAINT "metrics_hourly_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_hourly" ADD CONSTRAINT "metrics_hourly_entity_fk" FOREIGN KEY ("entity_id","account_id","level") REFERENCES "public"."entities"("id","account_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_events_account_changed_at_idx" ON "change_events" USING btree ("account_id","changed_at");--> statement-breakpoint
CREATE INDEX "change_events_resource_changed_at_idx" ON "change_events" USING btree ("resource_name","changed_at");--> statement-breakpoint
CREATE INDEX "entities_parent_id_idx" ON "entities" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "g_audience_metrics_account_date_idx" ON "g_audience_metrics" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "g_search_terms_account_date_idx" ON "g_search_terms" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "metrics_daily_account_level_date_idx" ON "metrics_daily" USING btree ("account_id","level","date");--> statement-breakpoint
CREATE INDEX "metrics_hourly_account_level_date_idx" ON "metrics_hourly" USING btree ("account_id","level","date");