CREATE TYPE "public"."pull_request_checks" AS ENUM('none', 'pending', 'success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."pull_request_review" AS ENUM('none', 'approved', 'changes_requested', 'commented');--> statement-breakpoint
CREATE TYPE "public"."pull_request_state" AS ENUM('open', 'merged', 'closed');--> statement-breakpoint
CREATE TABLE "task_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"provider" "repo_provider" NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"head_branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"head_sha" text,
	"state" "pull_request_state" DEFAULT 'open' NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"checks" "pull_request_checks" DEFAULT 'none' NOT NULL,
	"review" "pull_request_review" DEFAULT 'none' NOT NULL,
	"nudge_signature" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fix_rounds" integer DEFAULT 0 NOT NULL,
	"last_comment_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_pull_requests_repoId_number_unique" UNIQUE("repo_id","number")
);
--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD CONSTRAINT "task_pull_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD CONSTRAINT "task_pull_requests_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_pull_requests_task_id_index" ON "task_pull_requests" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_pull_requests_state_synced_at_index" ON "task_pull_requests" USING btree ("state","synced_at");