CREATE TABLE "slack_events_seen" (
	"event_id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_events_seen" ADD CONSTRAINT "slack_events_seen_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_events_seen_seen_at_idx" ON "slack_events_seen" USING btree ("seen_at");