-- v1 has exactly one org (ADR-0001). Keep the id in sync with DEFAULT_ORG_ID in src/schema/identity.ts.
INSERT INTO "orgs" ("id", "name") VALUES ('00000000-0000-0000-0000-000000000001', 'Arlo')
ON CONFLICT ("id") DO NOTHING;
