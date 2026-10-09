CREATE TABLE "app_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "timezone" SET DEFAULT 'UTC';--> statement-breakpoint
-- Bookkeeping rows move out of the settings table.
INSERT INTO "app_state" ("key", "value", "updated_at")
SELECT "key", "value", "updated_at" FROM "settings" WHERE "key" IN ('env_imported', 'embeddings_reindex', 'seeded_templates');
--> statement-breakpoint
DELETE FROM "settings" WHERE "key" IN ('env_imported', 'embeddings_reindex', 'seeded_templates');
--> statement-breakpoint
-- The flat "app" row becomes one row per domain, keeping only the fields that were saved.
INSERT INTO "settings" ("key", "value")
SELECT d."key", jsonb_strip_nulls(d."value")
FROM "settings" s,
LATERAL (VALUES
  ('general', jsonb_build_object('locale', s."value"->'locale', 'timezone', s."value"->'timezone')),
  ('models', jsonb_build_object(
    'chains', jsonb_build_object(
      'agent', s."value"->'defaultModels',
      'manager', s."value"->'managerModels',
      'orchestrator', s."value"->'orchestratorModels'),
    'reasoningEffort', jsonb_build_object(
      'agent', s."value"->'defaultReasoningEffort',
      'manager', s."value"->'managerReasoningEffort',
      'orchestrator', s."value"->'orchestratorReasoningEffort'),
    'ollama', jsonb_build_object('enabled', s."value"->'ollamaEnabled', 'baseUrl', s."value"->'ollamaBaseUrl'))),
  ('agents', jsonb_build_object(
    'instructions', s."value"->'agentInstructions',
    'parallelDelegations', s."value"->'parallelDelegations')),
  ('memory', jsonb_build_object(
    'embeddingProvider', s."value"->'embeddingProvider',
    'requiresApproval', s."value"->'memoryRequiresApproval',
    'pinnedTokens', s."value"->'memoryPinnedTokens',
    'recallTokens', s."value"->'memoryRecallTokens',
    'journalDays', s."value"->'journalDays')),
  ('sandbox', COALESCE(s."value"->'sandbox', '{}'::jsonb)),
  ('telegram', jsonb_build_object(
    'allowedUserIds', s."value"->'telegramAllowedUserIds',
    'notifyChatId', s."value"->'telegramNotifyChatId')),
  ('reports', jsonb_build_object('daily', jsonb_build_object('hour', s."value"->'digestHour'))),
  ('budget', jsonb_build_object('monthlyUsd', s."value"->'monthlyBudgetUsd')),
  ('system', jsonb_build_object(
    'runConcurrency', s."value"->'runConcurrency',
    'updateChecks', s."value"->'updateChecks'))
) AS d("key", "value")
WHERE s."key" = 'app'
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
DELETE FROM "settings" WHERE "key" = 'app';
--> statement-breakpoint
-- The default time zone was Europe/Bucharest before it became UTC: an existing install keeps it.
INSERT INTO "settings" ("key", "value")
SELECT 'general', '{"timezone": "Europe/Bucharest"}'::jsonb
WHERE EXISTS (SELECT 1 FROM "agents")
ON CONFLICT ("key") DO UPDATE
SET "value" = jsonb_build_object('timezone', 'Europe/Bucharest') || "settings"."value"
WHERE NOT ("settings"."value" ? 'timezone');
--> statement-breakpoint
-- Nested objects left empty by the strip ({"chains": {}}) are harmless; empty rows are dropped.
DELETE FROM "settings" WHERE "value" = '{}'::jsonb;
