ALTER TABLE "memories" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_run_idx" ON "memories" USING btree ("run_id") WHERE "memories"."run_id" is not null;