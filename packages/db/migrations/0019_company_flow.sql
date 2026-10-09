-- The values added to task_status and run_failure_kind with ADD VALUE cannot be used before this migration's
-- transaction commits: no statement here (nor in a later migration applied in the same run) may name them.
CREATE TYPE "public"."question_status" AS ENUM('open', 'answered', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('work', 'help');--> statement-breakpoint
CREATE TYPE "public"."task_message_kind" AS ENUM('note', 'instruction', 'question', 'answer', 'progress', 'notice');--> statement-breakpoint
ALTER TYPE "public"."run_failure_kind" ADD VALUE 'paused';--> statement-breakpoint
ALTER TYPE "public"."run_failure_kind" ADD VALUE 'cancelled_by_agent';--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'paused';--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "retried_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "priority" smallint DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "kind" "task_message_kind" DEFAULT 'note' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "author_run_id" uuid;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "addressee_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "addressed_to_user" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "reply_to_id" uuid;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "question_status" "question_status";--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "escalation_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "escalate_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "delivered_message_id" text;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "delivered_run_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" "task_kind" DEFAULT 'work' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "report_group" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "paused_for_task_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "continuations" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "agent_rounds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "follow_ups" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "followed_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deadline_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deadline_missed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deadline_escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_retried_by_run_id_runs_id_fk" FOREIGN KEY ("retried_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_run_id_runs_id_fk" FOREIGN KEY ("author_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_addressee_agent_id_agents_id_fk" FOREIGN KEY ("addressee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_reply_to_id_task_comments_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."task_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_delivered_run_id_runs_id_fk" FOREIGN KEY ("delivered_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_paused_for_task_id_tasks_id_fk" FOREIGN KEY ("paused_for_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_retry_at_index" ON "runs" USING btree ("retry_at") WHERE "runs"."retry_at" is not null and "runs"."retried_by_run_id" is null;--> statement-breakpoint
CREATE INDEX "task_comments_escalate_at_index" ON "task_comments" USING btree ("escalate_at") WHERE "task_comments"."question_status" = 'open';--> statement-breakpoint
CREATE INDEX "task_comments_addressed_to_user_index" ON "task_comments" USING btree ("addressed_to_user") WHERE "task_comments"."question_status" = 'open';--> statement-breakpoint
CREATE INDEX "tasks_deadline_index" ON "tasks" USING btree ("deadline") WHERE "tasks"."deadline" is not null and "tasks"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_paused_for_task_id_index" ON "tasks" USING btree ("paused_for_task_id") WHERE "tasks"."paused_for_task_id" is not null;--> statement-breakpoint
CREATE INDEX "tasks_status_activity_at_index" ON "tasks" USING btree ("status","activity_at");--> statement-breakpoint
-- Existing tasks were last active when they last changed.
UPDATE "tasks" SET "activity_at" = "updated_at";
