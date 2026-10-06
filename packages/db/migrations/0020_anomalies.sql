CREATE TABLE "anomalies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"entity_id" uuid,
	"entity_key" text DEFAULT '' NOT NULL,
	"detected_on" date NOT NULL,
	"metric" text NOT NULL,
	"segment" text DEFAULT '' NOT NULL,
	"value" numeric(24, 6) NOT NULL,
	"baseline" numeric(24, 6) NOT NULL,
	"z" numeric(12, 4) NOT NULL,
	"direction" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"explanation" text,
	"explained_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anomalies_direction" CHECK ("anomalies"."direction" in ('up', 'down'))
);
--> statement-breakpoint
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anomalies_key" ON "anomalies" USING btree ("account_id","entity_key","detected_on","metric","segment");--> statement-breakpoint
CREATE INDEX "anomalies_account_detected_idx" ON "anomalies" USING btree ("account_id","detected_on");