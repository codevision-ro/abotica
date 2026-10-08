CREATE TYPE "public"."memory_origin" AS ENUM('owner', 'agent', 'untrusted', 'system');--> statement-breakpoint
CREATE TYPE "public"."memory_recall_source" AS ENUM('search', 'context');--> statement-breakpoint
CREATE TYPE "public"."memory_retention" AS ENUM('permanent', 'durable', 'ephemeral');--> statement-breakpoint
CREATE TABLE "memory_recalls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"run_id" uuid,
	"source" "memory_recall_source" NOT NULL,
	"query_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journals" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(summary, ''))) STORED;--> statement-breakpoint
ALTER TABLE "journals" ADD COLUMN "from_untrusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "origin" "memory_origin";--> statement-breakpoint
UPDATE "memories" SET "origin" = (CASE "source" WHEN 'manual' THEN 'owner' WHEN 'consolidation' THEN 'system' ELSE 'agent' END)::"memory_origin";--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "origin" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "flag_reason" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "retention" "memory_retention" DEFAULT 'durable' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_from" date;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "recall_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "last_recalled_at" timestamp with time zone;--> statement-breakpoint
UPDATE "memories" SET "retention" = 'permanent' WHERE "source" = 'manual';--> statement-breakpoint
UPDATE "memories" SET "pinned" = true WHERE "source" = 'manual' AND "scope" = 'global';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "read_untrusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_recalls" ADD CONSTRAINT "memory_recalls_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_recalls" ADD CONSTRAINT "memory_recalls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_recalls_memory_id_index" ON "memory_recalls" USING btree ("memory_id");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_memories_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journals_search_idx" ON "journals" USING gin ("search");--> statement-breakpoint
CREATE INDEX "memories_pinned_idx" ON "memories" USING btree ("scope","project_id","agent_id") WHERE "memories"."pinned";--> statement-breakpoint
CREATE INDEX "memories_search_idx" ON "memories" USING gin ("search");