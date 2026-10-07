CREATE TYPE "public"."repo_provider" AS ENUM('github', 'gitlab');--> statement-breakpoint
CREATE TABLE "project_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" "repo_provider" NOT NULL,
	"host" text NOT NULL,
	"path" text NOT NULL,
	"default_branch" text NOT NULL,
	"token" text NOT NULL,
	"token_hint" text NOT NULL,
	"default_branch_protected" boolean,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_repos_projectId_name_unique" UNIQUE("project_id","name"),
	CONSTRAINT "project_repos_projectId_host_path_unique" UNIQUE("project_id","host","path")
);
--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;