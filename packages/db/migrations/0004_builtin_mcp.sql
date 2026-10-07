CREATE TYPE "public"."mcp_workspace" AS ENUM('server', 'run');--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "workspace" "mcp_workspace" DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "global" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "builtin" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_builtin_unique" UNIQUE("builtin");