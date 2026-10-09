-- Agents act without asking by default: every "ask" entry, built-in tools and "mcp:..." keys alike,
-- becomes "allow". "deny" and "allow" stay as they are, so running it again changes nothing.
UPDATE "agents"
SET "permissions" = (
	SELECT jsonb_object_agg(e."key", CASE WHEN e."value" = '"ask"'::jsonb THEN '"allow"'::jsonb ELSE e."value" END)
	FROM jsonb_each("agents"."permissions") e
)
WHERE jsonb_typeof("permissions") = 'object'
	AND EXISTS (SELECT 1 FROM jsonb_each("agents"."permissions") e WHERE e."value" = '"ask"'::jsonb);
