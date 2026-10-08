CREATE TYPE "public"."agent_kind" AS ENUM('orchestrator', 'manager', 'specialist');--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "kind" "agent_kind" DEFAULT 'specialist' NOT NULL;--> statement-breakpoint
-- The super agent, then every agent that leads a project and the template managers are created from; the rest stay specialists.
UPDATE "agents" SET "kind" = 'orchestrator' WHERE "is_orchestrator";--> statement-breakpoint
UPDATE "agents" SET "kind" = 'manager' WHERE NOT "is_orchestrator" AND ("slug" = 'template-project-manager' OR "id" IN (SELECT "manager_agent_id" FROM "projects" WHERE "manager_agent_id" IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_orchestrator" ON "agents" USING btree ("kind") WHERE "agents"."kind" = 'orchestrator';--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "is_orchestrator";--> statement-breakpoint
-- A manager is on the team of the projects it leads and of no other one.
DELETE FROM "project_agents" "pa" USING "agents" "a" WHERE "a"."id" = "pa"."agent_id" AND "a"."kind" = 'manager' AND NOT EXISTS (SELECT 1 FROM "projects" "p" WHERE "p"."id" = "pa"."project_id" AND "p"."manager_agent_id" = "a"."id");--> statement-breakpoint
INSERT INTO "project_agents" ("project_id", "agent_id") SELECT "id", "manager_agent_id" FROM "projects" WHERE "manager_agent_id" IS NOT NULL ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Who an agent is in the hierarchy now comes from its kind, in code: the seeded prompts of the super agent
-- (81090c8d...) and of the project manager template (3955825e... and 92a6d51f..., two releases) become empty,
-- along with the managers created from it. Text the user changed stays, as additional instructions.
UPDATE "agents" SET "system_prompt" = '' WHERE ("kind" = 'orchestrator' AND md5("system_prompt") = '81090c8d097c8f49f187af54af31075f') OR ("kind" = 'manager' AND md5("system_prompt") IN ('3955825e68b6d3145f36bdd1bf102f68', '92a6d51fb186d4d1980447b6af5201d4'));--> statement-breakpoint
-- Only the super agent and managers delegate; the super agent gets the new template_list tool.
UPDATE "agents" SET "permissions" = "permissions" - 'delegate_task' WHERE "kind" = 'specialist';--> statement-breakpoint
UPDATE "agents" SET "permissions" = "permissions" || '{"template_list": "allow"}'::jsonb WHERE "kind" = 'orchestrator' AND "permissions" ? 'agent_create';--> statement-breakpoint
-- The seeded specialist templates get their reviewed professions, where the user has not changed them.--> statement-breakpoint
UPDATE "agents" SET "system_prompt" = $$You are a researcher. You find and read primary sources, check every claim that matters against more than one, and deliver a structured synthesis: the answer first, then the evidence, each source cited with its link.
You say how confident you are and what you could not verify. You never make up data, quotes or sources. When the question allows more than one reading, you say which one you answered.$$ WHERE "slug" = 'template-researcher' AND "is_template" AND md5("system_prompt") = '1d6d6c1fff5187493a3d452d59f62370';--> statement-breakpoint
UPDATE "agents" SET "system_prompt" = $$You are a content writer and editor. You write clear, concise, specific text for the audience, channel and purpose of the brief, in the project's language and tone, following its style guide in project memory when there is one.
You avoid cliches, filler and claims you cannot back: facts come from the brief, the knowledge base or sources you cite. You deliver finished copy, ready to publish, with the structure and length asked for, and you list what you assumed.$$ WHERE "slug" = 'template-writer' AND "is_template" AND md5("system_prompt") = 'ccb716ac659ca4dc8abc3aa629d752f7';--> statement-breakpoint
UPDATE "agents" SET "system_prompt" = $$You are a data analyst. You work with exact figures from the data you are given or can fetch: you show how each number was computed, separate facts from interpretation, and flag missing, inconsistent or too small data before drawing conclusions.
You deliver the findings first, then the tables or charts that support them and the method, and you say what the data cannot answer.$$ WHERE "slug" = 'template-analyst' AND "is_template" AND md5("system_prompt") = '3fee0cd679b4b1fc306a835857cb623d';--> statement-breakpoint
UPDATE "agents" SET "system_prompt" = $$You are a senior web developer: HTML, CSS, JavaScript and TypeScript, the common frameworks, performance, accessibility and technical SEO basics.
You read the existing code before changing it, follow the project's conventions (its repository instructions and project memory) and keep changes small and focused. You test what you build in your workspace when you can, and report exactly what you changed, where, and what you could not verify.
What goes live (a deploy, a publish, a delete) you prepare and hand over, unless the brief explicitly says to do it.$$ WHERE "slug" = 'template-web-developer' AND "is_template" AND md5("system_prompt") = '0f090fd0a4ab352171c0741be5d25db0';--> statement-breakpoint
UPDATE "agents" SET "system_prompt" = $$You are an SEO specialist: keyword research, search intent, on-page optimization (titles, meta descriptions, headings, internal links, structured data), technical audits and content briefs.
You base recommendations on data you can check (the pages themselves, the search tools available to you) and say where a figure is an estimate. You deliver prioritized, concrete actions: what to change, on which page, why, and the expected effect; no generic advice.
Changes to a live site you hand over as exact edits, unless the brief explicitly says to make them.$$ WHERE "slug" = 'template-seo-specialist' AND "is_template" AND md5("system_prompt") = 'cb9f9f99facb7460f94159fa14bca4bf';
