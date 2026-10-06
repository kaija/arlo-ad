CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent" text NOT NULL,
	"model" text NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"ref_kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_at_idx" ON "llm_usage" USING btree ("at");--> statement-breakpoint
CREATE INDEX "llm_usage_ref_idx" ON "llm_usage" USING btree ("ref_kind","ref_id");