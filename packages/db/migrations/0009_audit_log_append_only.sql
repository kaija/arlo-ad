-- audit_log is append-only (Requirement 3.6): reject UPDATE, DELETE and TRUNCATE for every role.
CREATE FUNCTION "public"."audit_log_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_log_no_update_delete" BEFORE UPDATE OR DELETE ON "public"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "public"."audit_log_append_only"();--> statement-breakpoint
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "public"."audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_log_append_only"();
