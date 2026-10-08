CREATE TYPE "public"."task_wakeup_kind" AS ENUM('timer', 'pr_checks_finished', 'pr_merged', 'subtasks_done', 'task_status');--> statement-breakpoint
CREATE TYPE "public"."task_wakeup_paused_reason" AS ENUM('max_fires', 'loop', 'rate');--> statement-breakpoint
CREATE TYPE "public"."task_wakeup_status" AS ENUM('active', 'fired', 'paused', 'expired');--> statement-breakpoint
CREATE TABLE "task_wakeups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid,
	"created_by_run_id" uuid,
	"kind" "task_wakeup_kind" NOT NULL,
	"key" text NOT NULL,
	"condition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"next_check_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"max_fires" integer DEFAULT 1 NOT NULL,
	"fires" integer DEFAULT 0 NOT NULL,
	"chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fingerprint" text,
	"status" "task_wakeup_status" DEFAULT 'active' NOT NULL,
	"paused_reason" "task_wakeup_paused_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_wakeups_taskId_key_unique" UNIQUE("task_id","key")
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "credential_routes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_wakeups" ADD CONSTRAINT "task_wakeups_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_wakeups" ADD CONSTRAINT "task_wakeups_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_wakeups" ADD CONSTRAINT "task_wakeups_created_by_run_id_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_wakeups_status_kind_index" ON "task_wakeups" USING btree ("status","kind");--> statement-breakpoint
-- task_wait is new: agents get it at the permission they have for task_update, the tool it pairs with.
UPDATE "agents" SET "permissions" = "permissions" || jsonb_build_object('task_wait', "permissions"->'task_update') WHERE "permissions" ? 'task_update' AND NOT "permissions" ? 'task_wait';
