ALTER TABLE "agents" ALTER COLUMN "limits" SET DEFAULT '{"maxSteps":150,"timeoutMs":7200000,"budgetUsd":null}'::jsonb;--> statement-breakpoint
-- Existing agents get at least the new limits: a stop at a limit leaves the work unfinished, and the monthly
-- budget, not a small per-run one, guards cost. A per-run budget of up to 5 USD came from the old defaults and
-- templates and is dropped; a larger one was set on purpose and stays. Running it again changes nothing.
UPDATE "agents"
SET "limits" = jsonb_build_object(
	'maxSteps', GREATEST(COALESCE(("limits"->>'maxSteps')::int, 0), 150),
	'timeoutMs', GREATEST(COALESCE(("limits"->>'timeoutMs')::bigint, 0), 7200000),
	'budgetUsd', CASE
		WHEN "limits"->'budgetUsd' IS NULL OR jsonb_typeof("limits"->'budgetUsd') = 'null' THEN 'null'::jsonb
		WHEN ("limits"->>'budgetUsd')::numeric <= 5 THEN 'null'::jsonb
		ELSE "limits"->'budgetUsd'
	END
)
WHERE COALESCE(("limits"->>'maxSteps')::int, 0) < 150
	OR COALESCE(("limits"->>'timeoutMs')::bigint, 0) < 7200000
	OR (jsonb_typeof("limits"->'budgetUsd') = 'number' AND ("limits"->>'budgetUsd')::numeric <= 5);
