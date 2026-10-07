import { createRedis, OWNER_SECRETS, QUEUE, type SandboxJob, type SandboxStatus } from "@abotica/core";
import { probeMcpServer } from "@abotica/core/agents/mcp-runtime";
import { Worker } from "bullmq";

/** One log line: the runtime in use, or why the sandbox is not running. */
export function describeSandbox(status: SandboxStatus): string {
  if (status.isolation) return `docker (${status.isolation})`;
  if (!status.enabled) return "off in Settings > Sandbox";
  return `not running: ${status.docker.reason ?? "Docker is not available"}`;
}

/** Requests that need the sandbox this worker owns; the caller waits for the returned value. */
export function startSandboxWorker() {
  return new Worker<SandboxJob>(
    QUEUE.sandbox,
    async (job) => {
      switch (job.data.kind) {
        case "mcp-test":
          // Only the registry's "Test" and "Sync tools" send this job: the user's own, with every secret.
          return probeMcpServer(job.data.server, OWNER_SECRETS, job.data.timeoutMs);
      }
    },
    // Tests mostly wait on a process starting; a few in parallel keep the form responsive.
    { connection: createRedis(), concurrency: 4 },
  );
}
