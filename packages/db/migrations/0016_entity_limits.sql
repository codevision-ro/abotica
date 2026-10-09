ALTER TABLE "conversations" ALTER COLUMN "title" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "rate_limit_per_minute" integer;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "connect_timeout_sec" integer;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "call_timeout_sec" integer;