CREATE TYPE "public"."campaign_task_status" AS ENUM('queued', 'running', 'draft', 'submitted', 'failed');--> statement-breakpoint
CREATE TABLE "campaign_drafts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"draft" jsonb NOT NULL,
	"lint_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" text NOT NULL,
	"policy_status" jsonb,
	"changeset_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_drafts_task_version_key" UNIQUE("task_id","version")
);
--> statement-breakpoint
CREATE TABLE "campaign_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"brief" jsonb NOT NULL,
	"status" "campaign_task_status" DEFAULT 'queued' NOT NULL,
	"created_by" uuid,
	"trace_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_task_id_campaign_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."campaign_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_changeset_id_changesets_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."changesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_tasks" ADD CONSTRAINT "campaign_tasks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_tasks" ADD CONSTRAINT "campaign_tasks_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_tasks" ADD CONSTRAINT "campaign_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_tasks_account_idx" ON "campaign_tasks" USING btree ("account_id","created_at");