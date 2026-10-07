CREATE TABLE "subscription_connections" (
	"provider" text PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL,
	"client_id" text,
	"account" jsonb,
	"tokens" text,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
