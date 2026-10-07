CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('web', 'telegram', 'internal');--> statement-breakpoint
CREATE TYPE "public"."comment_author" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."file_source" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."knowledge_kind" AS ENUM('file', 'document', 'link');--> statement-breakpoint
CREATE TYPE "public"."mcp_auth" AS ENUM('headers', 'oauth');--> statement-breakpoint
CREATE TYPE "public"."mcp_transport" AS ENUM('http', 'stdio');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('global', 'project', 'agent');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('active', 'pending');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."reasoning_effort" AS ENUM('default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('chat', 'telegram', 'task', 'schedule', 'webhook', 'event', 'delegation', 'system');--> statement-breakpoint
CREATE TYPE "public"."schedule_kind" AS ENUM('cron', 'once');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('backlog', 'in_progress', 'blocked', 'review', 'done');--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_agentId_version_unique" UNIQUE("agent_id","version")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"avatar" jsonb DEFAULT '{"icon":"bot","color":"#6d28d9","background":"#ede9fe"}'::jsonb NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"provider" text,
	"model" text,
	"fallbacks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reasoning_effort" "reasoning_effort" DEFAULT 'default' NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '{"maxSteps":20,"timeoutMs":600000,"budgetUsd":1}'::jsonb NOT NULL,
	"is_orchestrator" boolean DEFAULT false NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"two_factor_enabled" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"kind" "schedule_kind" NOT NULL,
	"cron" text,
	"run_at" timestamp with time zone,
	"timezone" text DEFAULT 'Europe/Bucharest' NOT NULL,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"event" text NOT NULL,
	"token" text,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "triggers_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"project_id" uuid,
	"external_id" text,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"model_override" jsonb,
	"reasoning_effort" "reasoning_effort",
	"test_skill_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"source" "file_source" NOT NULL,
	"conversation_id" uuid,
	"task_id" uuid,
	"knowledge_item_id" uuid,
	"run_id" uuid,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_one_owner" CHECK (num_nonnulls("files"."conversation_id", "files"."task_id", "files"."knowledge_item_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"project_id" uuid,
	"day" date NOT NULL,
	"summary" text NOT NULL,
	"embedding" vector(768),
	"consolidated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journals_agentId_projectId_day_unique" UNIQUE NULLS NOT DISTINCT("agent_id","project_id","day")
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768)
);
--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "knowledge_kind" NOT NULL,
	"title" text NOT NULL,
	"source_url" text,
	"content" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"project_id" uuid,
	"agent_id" uuid,
	"content" text NOT NULL,
	"embedding" vector(768),
	"source" text DEFAULT 'manual' NOT NULL,
	"status" "memory_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_agents" (
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	CONSTRAINT "project_agents_project_id_agent_id_pk" PRIMARY KEY("project_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"goals" text DEFAULT '' NOT NULL,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"budget_usd" numeric(12, 4),
	"allowed_providers" text[] DEFAULT '{}' NOT NULL,
	"telegram_topic_id" bigint,
	"sandbox" jsonb,
	"manager_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agent_mcp_servers" (
	"agent_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	CONSTRAINT "agent_mcp_servers_agent_id_mcp_server_id_pk" PRIMARY KEY("agent_id","mcp_server_id")
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"client" text,
	"tokens" text,
	"auth_server" jsonb,
	"code_verifier" text,
	"state" text,
	"started_at" timestamp with time zone,
	"redirect_uri" text,
	"connected_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"scope" text,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"transport" "mcp_transport" NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"network" jsonb DEFAULT '{"mode":"full","domains":[]}'::jsonb NOT NULL,
	"sandboxed" boolean DEFAULT true NOT NULL,
	"auth" "mcp_auth" DEFAULT 'headers' NOT NULL,
	"oauth_client_id" text,
	"oauth_client_secret" text,
	"oauth_scope" text,
	"tools" jsonb,
	"tools_synced_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "project_mcp_servers" (
	"project_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	CONSTRAINT "project_mcp_servers_project_id_mcp_server_id_pk" PRIMARY KEY("project_id","mcp_server_id")
);
--> statement-breakpoint
CREATE TABLE "project_skills" (
	"project_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "project_skills_project_id_skill_id_pk" PRIMARY KEY("project_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skill_files" (
	"skill_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "skill_files_skill_id_path_pk" PRIMARY KEY("skill_id","path")
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_skillId_version_unique" UNIQUE("skill_id","version")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"approval_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"input" jsonb,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"telegram_message_id" integer,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"project_id" uuid,
	"task_id" uuid,
	"conversation_id" uuid,
	"parent_run_id" uuid,
	"trigger" "run_trigger" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"input" text DEFAULT '' NOT NULL,
	"output" text,
	"error" text,
	"provider" text,
	"model" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"value" text NOT NULL,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author_kind" "comment_author" DEFAULT 'user' NOT NULL,
	"author_agent_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_task_id_pk" PRIMARY KEY("task_id","depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"parent_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "task_status" DEFAULT 'backlog' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"deadline" timestamp with time zone,
	"assignee_agent_id" uuid,
	"assigned_to_user" boolean DEFAULT false NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"output" text,
	"created_by" text DEFAULT 'user' NOT NULL,
	"delegated_by_run_id" uuid,
	"reported_at" timestamp with time zone,
	"redelegations" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_test_skill_id_skills_id_fk" FOREIGN KEY ("test_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agents" ADD CONSTRAINT "project_agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agents" ADD CONSTRAINT "project_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_manager_agent_id_agents_id_fk" FOREIGN KEY ("manager_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth" ADD CONSTRAINT "mcp_oauth_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "project_mcp_servers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "project_mcp_servers_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_skills" ADD CONSTRAINT "project_skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_skills" ADD CONSTRAINT "project_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_delegated_by_run_id_runs_id_fk" FOREIGN KEY ("delegated_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "triggers_event_index" ON "triggers" USING btree ("event");--> statement-breakpoint
CREATE INDEX "conversations_agent_id_updated_at_index" ON "conversations" USING btree ("agent_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversations_project_id_updated_at_index" ON "conversations" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversations_channel_external_id_index" ON "conversations" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_created_at_index" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "files_conversation_id_index" ON "files" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "files_task_id_index" ON "files" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "files_knowledge_item_id_index" ON "files" USING btree ("knowledge_item_id");--> statement-breakpoint
CREATE INDEX "files_run_id_index" ON "files" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "journals_embedding_idx" ON "journals" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_chunks_project_id_index" ON "knowledge_chunks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memories_scope_project_id_agent_id_index" ON "memories" USING btree ("scope","project_id","agent_id");--> statement-breakpoint
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "approvals_status_index" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "approvals_run_id_index" ON "approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_events_run_id_id_index" ON "run_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_conversation" ON "runs" USING btree ("conversation_id") WHERE "runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "runs_agent_id_created_at_index" ON "runs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_index" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_project_id_created_at_index" ON "runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_created_at_index" ON "runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_index" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_type_entity_id_index" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "task_comments_task_id_index" ON "task_comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_events_task_id_index" ON "task_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tasks_project_id_status_index" ON "tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "tasks_assignee_agent_id_index" ON "tasks" USING btree ("assignee_agent_id");--> statement-breakpoint
CREATE INDEX "tasks_delegated_by_run_id_index" ON "tasks" USING btree ("delegated_by_run_id");