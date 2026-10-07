import { relations } from "drizzle-orm";
import { agents, agentVersions } from "./agents";
import { schedules, triggers } from "./automation";
import { conversations, messages } from "./conversations";
import { journals, knowledgeChunks, knowledgeItems, memories } from "./memory";
import { projectAgents, projects } from "./projects";
import { agentMcpServers, agentSkills, mcpServers, skills } from "./registry";
import { approvals, runEvents, runs } from "./runs";
import { taskComments, taskDependencies, taskEvents, tasks } from "./tasks";

export const projectsRelations = relations(projects, ({ many }) => ({
  agents: many(projectAgents),
  tasks: many(tasks),
  memories: many(memories),
  knowledge: many(knowledgeItems),
}));

export const projectAgentsRelations = relations(projectAgents, ({ one }) => ({
  project: one(projects, { fields: [projectAgents.projectId], references: [projects.id] }),
  agent: one(agents, { fields: [projectAgents.agentId], references: [agents.id] }),
}));

export const agentsRelations = relations(agents, ({ many }) => ({
  projects: many(projectAgents),
  versions: many(agentVersions),
  skills: many(agentSkills),
  mcpServers: many(agentMcpServers),
  runs: many(runs),
  journals: many(journals),
  schedules: many(schedules),
  triggers: many(triggers),
}));

export const agentVersionsRelations = relations(agentVersions, ({ one }) => ({
  agent: one(agents, { fields: [agentVersions.agentId], references: [agents.id] }),
}));

export const agentSkillsRelations = relations(agentSkills, ({ one }) => ({
  agent: one(agents, { fields: [agentSkills.agentId], references: [agents.id] }),
  skill: one(skills, { fields: [agentSkills.skillId], references: [skills.id] }),
}));

export const agentMcpServersRelations = relations(agentMcpServers, ({ one }) => ({
  agent: one(agents, { fields: [agentMcpServers.agentId], references: [agents.id] }),
  mcpServer: one(mcpServers, { fields: [agentMcpServers.mcpServerId], references: [mcpServers.id] }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  assignee: one(agents, { fields: [tasks.assigneeAgentId], references: [agents.id] }),
  parent: one(tasks, { fields: [tasks.parentId], references: [tasks.id], relationName: "subtasks" }),
  subtasks: many(tasks, { relationName: "subtasks" }),
  comments: many(taskComments),
  events: many(taskEvents),
  dependencies: many(taskDependencies, { relationName: "dependencies" }),
  runs: many(runs),
}));

export const taskDependenciesRelations = relations(taskDependencies, ({ one }) => ({
  task: one(tasks, { fields: [taskDependencies.taskId], references: [tasks.id], relationName: "dependencies" }),
  dependsOn: one(tasks, { fields: [taskDependencies.dependsOnTaskId], references: [tasks.id] }),
}));

export const taskCommentsRelations = relations(taskComments, ({ one }) => ({
  task: one(tasks, { fields: [taskComments.taskId], references: [tasks.id] }),
  author: one(agents, { fields: [taskComments.authorAgentId], references: [agents.id] }),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
  task: one(tasks, { fields: [taskEvents.taskId], references: [tasks.id] }),
}));

export const memoriesRelations = relations(memories, ({ one }) => ({
  project: one(projects, { fields: [memories.projectId], references: [projects.id] }),
  agent: one(agents, { fields: [memories.agentId], references: [agents.id] }),
}));

export const journalsRelations = relations(journals, ({ one }) => ({
  agent: one(agents, { fields: [journals.agentId], references: [agents.id] }),
}));

export const knowledgeItemsRelations = relations(knowledgeItems, ({ one, many }) => ({
  project: one(projects, { fields: [knowledgeItems.projectId], references: [projects.id] }),
  chunks: many(knowledgeChunks),
}));

export const knowledgeChunksRelations = relations(knowledgeChunks, ({ one }) => ({
  item: one(knowledgeItems, { fields: [knowledgeChunks.itemId], references: [knowledgeItems.id] }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  agent: one(agents, { fields: [conversations.agentId], references: [agents.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  agent: one(agents, { fields: [runs.agentId], references: [agents.id] }),
  project: one(projects, { fields: [runs.projectId], references: [projects.id] }),
  task: one(tasks, { fields: [runs.taskId], references: [tasks.id] }),
  conversation: one(conversations, { fields: [runs.conversationId], references: [conversations.id] }),
  parent: one(runs, { fields: [runs.parentRunId], references: [runs.id], relationName: "children" }),
  children: many(runs, { relationName: "children" }),
  events: many(runEvents),
  approvals: many(approvals),
}));

export const runEventsRelations = relations(runEvents, ({ one }) => ({
  run: one(runs, { fields: [runEvents.runId], references: [runs.id] }),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  run: one(runs, { fields: [approvals.runId], references: [runs.id] }),
  agent: one(agents, { fields: [approvals.agentId], references: [agents.id] }),
}));

export const schedulesRelations = relations(schedules, ({ one }) => ({
  agent: one(agents, { fields: [schedules.agentId], references: [agents.id] }),
  project: one(projects, { fields: [schedules.projectId], references: [projects.id] }),
}));

export const triggersRelations = relations(triggers, ({ one }) => ({
  agent: one(agents, { fields: [triggers.agentId], references: [agents.id] }),
  project: one(projects, { fields: [triggers.projectId], references: [projects.id] }),
}));
