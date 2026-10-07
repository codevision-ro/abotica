CREATE TYPE "public"."preview_kind" AS ENUM('static', 'live');--> statement-breakpoint
CREATE TABLE "previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host" text NOT NULL,
	"kind" "preview_kind" NOT NULL,
	"title" text NOT NULL,
	"project_id" uuid,
	"conversation_id" uuid,
	"workspace_key" text NOT NULL,
	"port" integer,
	"entry" text,
	"public" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "previews_host_unique" UNIQUE("host"),
	CONSTRAINT "previews_one_owner" CHECK (num_nonnulls("previews"."project_id", "previews"."conversation_id") = 1),
	CONSTRAINT "previews_kind_fields" CHECK (("previews"."kind" = 'live' and "previews"."port" is not null) or ("previews"."kind" = 'static' and "previews"."entry" is not null))
);
--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "previews_project_id_index" ON "previews" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "previews_conversation_id_index" ON "previews" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "previews_expires_at_index" ON "previews" USING btree ("expires_at");