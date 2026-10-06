CREATE TYPE "public"."shadow_verdict" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TABLE "shadow_feedback" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"changeset_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"verdict" "shadow_verdict" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shadow_feedback_changeset_user_key" UNIQUE("changeset_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "shadow_feedback" ADD CONSTRAINT "shadow_feedback_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_feedback" ADD CONSTRAINT "shadow_feedback_changeset_id_changesets_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."changesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_feedback" ADD CONSTRAINT "shadow_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shadow_feedback_changeset_idx" ON "shadow_feedback" USING btree ("changeset_id");