CREATE TYPE "public"."job_run_status" AS ENUM('running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."job_template" AS ENUM('daily_report', 'negative_kw_sweep', 'budget_rebalance', 'tracking_audit', 'anomaly_watch', 'custom_prompt');--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"scheduled_job_id" uuid,
	"template" "job_template" NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "job_run_status" DEFAULT 'running' NOT NULL,
	"output" jsonb,
	"error" text,
	"trace_id" text,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template" "job_template" NOT NULL,
	"cron" text NOT NULL,
	"tz" text DEFAULT 'Asia/Taipei' NOT NULL,
	"account_ids" uuid[],
	"target" jsonb NOT NULL,
	"extra_instructions" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_jobs_account_ids_not_empty" CHECK ("scheduled_jobs"."account_ids" is null or cardinality("scheduled_jobs"."account_ids") > 0)
);
--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_scheduled_job_id_scheduled_jobs_id_fk" FOREIGN KEY ("scheduled_job_id") REFERENCES "public"."scheduled_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_runs_scheduled_job_started_idx" ON "job_runs" USING btree ("scheduled_job_id","started_at");