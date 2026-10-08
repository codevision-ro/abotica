import "server-only";
import { getTelegramToken, isProviderConfigured, PROVIDER_IDS } from "@abotica/core";
import { agents, approvals, db, projects, runs, tasks } from "@abotica/db";
import { and, asc, count, countDistinct, desc, eq, inArray, sql } from "@abotica/db/orm";
import { getDailyCostByProvider, getMonthCosts } from "./costs";
import { runRowColumns } from "./runs";
import { query } from "@/server/query";

export const listPendingApprovals = query(async (limit?: number) => {
  const pending = db
    .select({
      id: approvals.id,
      runId: approvals.runId,
      toolName: approvals.toolName,
      input: approvals.input,
      reason: approvals.reason,
      createdAt: approvals.createdAt,
      agentId: agents.id,
      agentName: agents.name,
      agentAvatar: agents.avatar,
    })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(eq(approvals.status, "pending"))
    .orderBy(desc(approvals.createdAt));
  return limit ? pending.limit(limit) : pending;
});

export type PendingApproval = Awaited<ReturnType<typeof listPendingApprovals>>[number];

export const getPendingApprovalCount = query(async (): Promise<number> => {
  const [row] = await db.select({ n: count() }).from(approvals).where(eq(approvals.status, "pending"));
  return row?.n ?? 0;
});

async function onboardingState() {
  const keyProviders = PROVIDER_IDS.filter((p) => p !== "ollama");
  const [configured, [agentCount], [projectCount], telegram] = await Promise.all([
    Promise.all(keyProviders.map((p) => isProviderConfigured(p).catch(() => false))),
    db
      .select({ n: count() })
      .from(agents)
      .where(and(eq(agents.isOrchestrator, false), eq(agents.isTemplate, false))),
    db.select({ n: count() }).from(projects),
    getTelegramToken().then(Boolean, () => false),
  ]);
  return {
    hasKeys: configured.some(Boolean),
    hasAgents: (agentCount?.n ?? 0) > 0,
    hasProjects: (projectCount?.n ?? 0) > 0,
    hasTelegram: telegram,
  };
}

export const getDashboard = query(async () => {
  const [active, taskCounts, approvalList, approvalCount, costs, daily, recentRuns, attention, onboarding] =
    await Promise.all([
      db
        .select({ runs: count(), agents: countDistinct(runs.agentId) })
        .from(runs)
        .where(inArray(runs.status, ["queued", "running"]))
        .then((r) => r[0] ?? { runs: 0, agents: 0 }),
      db
        .select({ status: tasks.status, n: count() })
        .from(tasks)
        .where(inArray(tasks.status, ["in_progress", "blocked", "review"]))
        .groupBy(tasks.status),
      listPendingApprovals(5),
      getPendingApprovalCount(),
      getMonthCosts(),
      getDailyCostByProvider(30),
      db
        .select(runRowColumns)
        .from(runs)
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .leftJoin(projects, eq(projects.id, runs.projectId))
        .orderBy(desc(runs.createdAt))
        .limit(10),
      db
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
          updatedAt: tasks.updatedAt,
          projectName: projects.name,
          agentName: agents.name,
          agentAvatar: agents.avatar,
        })
        .from(tasks)
        .leftJoin(projects, eq(projects.id, tasks.projectId))
        .leftJoin(agents, eq(agents.id, tasks.assigneeAgentId))
        .where(inArray(tasks.status, ["blocked", "review"]))
        .orderBy(sql`case when ${tasks.status} = 'blocked' then 0 else 1 end`, asc(tasks.updatedAt))
        .limit(8),
      onboardingState(),
    ]);

  const tasksByStatus = Object.fromEntries(taskCounts.map((t) => [t.status, t.n])) as Record<string, number>;
  return {
    active,
    tasks: {
      in_progress: tasksByStatus.in_progress ?? 0,
      blocked: tasksByStatus.blocked ?? 0,
      review: tasksByStatus.review ?? 0,
    },
    approvals: { list: approvalList, count: approvalCount },
    costs,
    daily,
    recentRuns,
    attention,
    onboarding,
  };
});
