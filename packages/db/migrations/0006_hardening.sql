ALTER TABLE "runs" DROP CONSTRAINT "runs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "access_token_expires_at" SET DATA TYPE timestamp with time zone USING "access_token_expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "refresh_token_expires_at" SET DATA TYPE timestamp with time zone USING "refresh_token_expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "two_factor" ALTER COLUMN "locked_until" SET DATA TYPE timestamp with time zone USING "locked_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_agent_id_index" ON "files" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_item_id_index" ON "knowledge_chunks" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "previews_run_id_index" ON "previews" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "previews_agent_id_index" ON "previews" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "project_agents_agent_id_index" ON "project_agents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "approvals_approval_id_index" ON "approvals" USING btree ("approval_id");--> statement-breakpoint
-- A task may have one queued or running run (runs_one_active_per_task): later duplicates are cancelled, the first keeps going.
UPDATE "runs" SET "status" = 'cancelled', "error" = 'Cancelled: the task already had an active run', "finished_at" = now() WHERE "id" IN (SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "task_id" ORDER BY "created_at") AS "n" FROM "runs" WHERE "task_id" IS NOT NULL AND "status" IN ('queued', 'running')) AS "active" WHERE "active"."n" > 1);--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_task" ON "runs" USING btree ("task_id") WHERE "runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "runs_task_id_index" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "runs_conversation_id_index" ON "runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "runs_parent_run_id_index" ON "runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_depends_on_task_id_index" ON "task_dependencies" USING btree ("depends_on_task_id");--> statement-breakpoint
CREATE INDEX "tasks_parent_id_index" ON "tasks" USING btree ("parent_id");--> statement-breakpoint
-- Agents can create schedules and webhook triggers that start runs; that now asks the user first (it was allowed).
UPDATE "agents" SET "permissions" = "permissions" || CASE WHEN "permissions"->>'schedule_manage' = 'allow' THEN '{"schedule_manage":"ask"}'::jsonb ELSE '{}'::jsonb END || CASE WHEN "permissions"->>'trigger_manage' = 'allow' THEN '{"trigger_manage":"ask"}'::jsonb ELSE '{}'::jsonb END WHERE "permissions"->>'schedule_manage' = 'allow' OR "permissions"->>'trigger_manage' = 'allow';
