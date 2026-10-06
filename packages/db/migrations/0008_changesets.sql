CREATE TYPE "public"."approval_message_kind" AS ENUM('origin', 'mirror', 'notice');--> statement-breakpoint
CREATE TYPE "public"."automation_feature" AS ENUM('negative_kw_auto', 'circuit_breaker', 'bid_auto_reduce', 'budget_rebalance');--> statement-breakpoint
CREATE TYPE "public"."changeset_source" AS ENUM('chat', 'schedule', 'monitor', 'web', 'undo');--> statement-breakpoint
CREATE TYPE "public"."changeset_status" AS ENUM('PENDING_VALIDATION', 'BLOCKED', 'PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'EXECUTED', 'FAILED', 'REJECTED', 'STALE', 'EXPIRED', 'SIMULATED', 'REVERTED');--> statement-breakpoint
CREATE TYPE "public"."rule_scope" AS ENUM('org', 'account', 'campaign');--> statement-breakpoint
CREATE TYPE "public"."rule_severity" AS ENUM('HARD_BLOCK', 'WARN');--> statement-breakpoint
CREATE TABLE "approval_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"changeset_id" uuid NOT NULL,
	"platform" text DEFAULT 'slack' NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"thread_id" text,
	"kind" "approval_message_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_messages_channel_message_key" UNIQUE("channel_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "changeset_op_results" (
	"org_id" uuid NOT NULL,
	"changeset_id" uuid NOT NULL,
	"op_index" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"resource_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "changeset_op_results_pk" PRIMARY KEY("changeset_id","op_index")
);
--> statement-breakpoint
CREATE TABLE "changesets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"account_id" uuid NOT NULL,
	"feature" "automation_feature",
	"source_kind" "changeset_source" NOT NULL,
	"source" jsonb NOT NULL,
	"ops" jsonb NOT NULL,
	"summary" text NOT NULL,
	"rationale" text,
	"tier" smallint,
	"status" "changeset_status" DEFAULT 'PENDING_VALIDATION' NOT NULL,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status_reason" text,
	"requested_by_kind" text NOT NULL,
	"requested_by_user_id" uuid,
	"approved_by" uuid,
	"expires_at" timestamp with time zone,
	"revert_of" uuid,
	"trace_id" text,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "changesets_tier_range" CHECK ("changesets"."tier" is null or "changesets"."tier" between 0 and 3),
	CONSTRAINT "changesets_requested_by_kind" CHECK ("changesets"."requested_by_kind" in ('user', 'agent', 'system')),
	CONSTRAINT "changesets_ops_array" CHECK (jsonb_typeof("changesets"."ops") = 'array')
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope_kind" "rule_scope" NOT NULL,
	"account_id" uuid,
	"campaign_entity_id" uuid,
	"spec" jsonb NOT NULL,
	"severity" "rule_severity" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_scope_consistent" CHECK (("rules"."scope_kind" = 'org' and "rules"."account_id" is null and "rules"."campaign_entity_id" is null)
        or ("rules"."scope_kind" = 'account' and "rules"."account_id" is not null and "rules"."campaign_entity_id" is null)
        or ("rules"."scope_kind" = 'campaign' and "rules"."account_id" is not null and "rules"."campaign_entity_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "tier_thresholds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid,
	"tier3_pct" numeric(6, 4) NOT NULL,
	"tier3_amount_micros" bigint,
	"tier1_max_reduce_pct" numeric(6, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tier_thresholds_pcts" CHECK ("tier_thresholds"."tier3_pct" > 0 and "tier_thresholds"."tier1_max_reduce_pct" >= 0 and "tier_thresholds"."tier1_max_reduce_pct" <= 1)
);
--> statement-breakpoint
ALTER TABLE "approval_messages" ADD CONSTRAINT "approval_messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_messages" ADD CONSTRAINT "approval_messages_changeset_id_changesets_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."changesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changeset_op_results" ADD CONSTRAINT "changeset_op_results_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changeset_op_results" ADD CONSTRAINT "changeset_op_results_changeset_id_changesets_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."changesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_revert_of_fk" FOREIGN KEY ("revert_of") REFERENCES "public"."changesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_campaign_entity_id_entities_id_fk" FOREIGN KEY ("campaign_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier_thresholds" ADD CONSTRAINT "tier_thresholds_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier_thresholds" ADD CONSTRAINT "tier_thresholds_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_messages_changeset_idx" ON "approval_messages" USING btree ("changeset_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_kind","entity_id","at");--> statement-breakpoint
CREATE INDEX "changesets_status_idx" ON "changesets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "changesets_account_created_idx" ON "changesets" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tier_thresholds_org_default_key" ON "tier_thresholds" USING btree ("org_id") WHERE "tier_thresholds"."account_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "tier_thresholds_account_key" ON "tier_thresholds" USING btree ("org_id","account_id") WHERE "tier_thresholds"."account_id" is not null;