CREATE TYPE "public"."role" AS ENUM('viewer', 'operator', 'approver', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'unbound', 'disabled');--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_bindings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"account_ids" text[],
	"max_tier" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_bindings_max_tier_range" CHECK ("role_bindings"."max_tier" between 0 and 3),
	CONSTRAINT "role_bindings_account_ids_not_empty" CHECK ("role_bindings"."account_ids" is null or cardinality("role_bindings"."account_ids") > 0)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_org_id_key_pk" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"google_email" text NOT NULL,
	"slack_user_id" text,
	"display_name" text,
	"status" "user_status" DEFAULT 'unbound' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_org_google_email_key" UNIQUE("org_id","google_email"),
	CONSTRAINT "users_org_slack_user_id_key" UNIQUE("org_id","slack_user_id"),
	CONSTRAINT "users_google_email_lowercase" CHECK ("users"."google_email" = lower("users"."google_email")),
	CONSTRAINT "users_status_matches_slack_binding" CHECK ("users"."status" = 'disabled' or ("users"."status" = 'active') = ("users"."slack_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_bindings_user_id_idx" ON "role_bindings" USING btree ("user_id");