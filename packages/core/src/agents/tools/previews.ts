import net from "node:net";
import path from "node:path";
import { collectBytes, runCommand, shellQuote } from "@abotica/sandbox";
import { tool } from "ai";
import { z } from "zod";
import { PREVIEW_MAX_BYTES, readSnapshotTar, SnapshotTooLargeError } from "../../sandbox/preview-snapshot";
import {
  createLivePreview,
  type Preview,
  type PreviewOwner,
  publishStaticPreview,
  previewUrl,
} from "../../sandbox/previews";
import { currentSandboxBackend } from "../../sandbox/sandbox-runtime";
import type { RunContext } from "../context";
import { blankToUndefined, errorResult, optionalId, type ToolFactory } from "./shared";

const NO_SANDBOX = { error: "The workspace is not available in this run." };
/** Room above the content limit for the archive's own headers. */
const ARCHIVE_SLACK = 8 * 1024 * 1024;
const PORT_CHECK_MS = 3_000;

/** Previews belong to the run's project, or else its conversation. */
function ownerOf(ctx: RunContext): PreviewOwner | null {
  if (ctx.projectId) return { projectId: ctx.projectId };
  return ctx.run.conversationId ? { conversationId: ctx.run.conversationId } : null;
}

const describe = (preview: Preview) => ({
  previewId: preview.id,
  url: previewUrl(preview),
  title: preview.title,
  public: preview.public,
  expiresAt: preview.expiresAt.toISOString(),
});

const publicInput = () =>
  z
    .preprocess(blankToUndefined, z.boolean().default(false))
    .describe("Anyone with the link can open it. Only when the user asked for a link to share; private otherwise.");

/** Whether something accepts connections on the container's port. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PORT_CHECK_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export const previewTools: Record<string, ToolFactory> = {
  preview_publish: (ctx) =>
    tool({
      description:
        "Publish a file or folder of your workspace as a preview: a copy served on its own address, which the user opens in a browser. Use it for HTML mockups, static sites, reports and documents (HTML, PDF, images). A folder is served with its index.html at the root (or a list of its files), and links between its files keep working. Publish again with previewId to update the same link after changes. Lasts 7 days. Give the user the link.",
      inputSchema: z.object({
        path: z.string().trim().min(1).describe("File or folder in your workspace, e.g. mockup/ or report.pdf."),
        title: z.string().trim().min(1).max(120).describe("What it is, as the user sees it."),
        previewId: optionalId().describe("A static preview you published before, to update instead of creating one."),
        public: publicInput(),
      }),
      execute: async ({ path: target, title, previewId, public: isPublic }, { abortSignal }) => {
        try {
          const owner = ownerOf(ctx);
          if (!owner) return { error: "This run has no project or conversation to publish the preview in." };
          if (!ctx.sandbox) return NO_SANDBOX;
          const workspace = await ctx.sandbox.workspace();
          const quoted = shellQuote(target);
          const kind = await runCommand(workspace, {
            command: `if [ -d ${quoted} ]; then echo folder; elif [ -f ${quoted} ]; then echo file; fi`,
            egress: [],
            timeoutMs: 30_000,
            signal: abortSignal,
          });
          const isFolder = kind.stdout.trim() === "folder";
          if (!isFolder && kind.stdout.trim() !== "file") return { error: `${target} does not exist in your workspace.` };
          const base = path.posix.basename(target);
          // The archive keeps links as links: readSnapshotTar drops them, so nothing outside is copied.
          const command = isFolder
            ? `exec tar --format=gnu -cf - -C ${quoted} .`
            : `exec tar --format=gnu -cf - -C ${shellQuote(path.posix.dirname(target))} ${shellQuote(base)}`;
          const proc = await workspace.exec({ command, egress: [], timeoutMs: 120_000, signal: abortSignal });
          const [archive, stderr, status] = await Promise.all([
            collectBytes(proc.stdout, PREVIEW_MAX_BYTES + ARCHIVE_SLACK),
            collectBytes(proc.stderr, 4096),
            proc.wait(),
          ]);
          if (archive.truncated) throw new SnapshotTooLargeError("The preview is larger than 50 MB.");
          if (status.exitCode !== 0) {
            return { error: new TextDecoder().decode(stderr.bytes).trim() || `Copying ${target} failed.` };
          }
          const snapshot = readSnapshotTar(archive.bytes);
          if (!snapshot.files.length) return { error: `${target} has no files to publish.` };
          const entry = isFolder ? (snapshot.files.some((f) => f.path === "index.html") ? "index.html" : "") : base;
          const preview = await publishStaticPreview({
            owner,
            workspaceKey: workspace.key,
            files: snapshot.files,
            entry,
            title,
            public: isPublic,
            previewId,
            agentId: ctx.agent.id,
            runId: ctx.run.id,
          });
          return {
            ...describe(preview),
            files: snapshot.files.length,
            ...(snapshot.skipped.length && {
              skipped: snapshot.skipped.slice(0, 20),
              note: "Links and special files are not copied.",
            }),
          };
        } catch (error) {
          if (abortSignal?.aborted) throw error;
          return errorResult(error);
        }
      },
    }),

  preview_open: (ctx) =>
    tool({
      description:
        "Give the user a link to an app you started in your workspace (a dev server, `php artisan serve`, `npm run dev`). Start the app first, in the background and listening on 0.0.0.0, not 127.0.0.1: `nohup php artisan serve --host=0.0.0.0 --port=8000 > serve.log 2>&1 &`. The link reaches that port while the app runs; it lasts 24 hours. The app sees the preview's host name: if it refuses unknown hosts (Vite), allow it (server.allowedHosts). Give the user the link.",
      inputSchema: z.object({
        port: z.coerce.number().int().min(1).max(65_535),
        title: z.string().trim().min(1).max(120).describe("What it is, as the user sees it."),
        public: publicInput(),
      }),
      execute: async ({ port, title, public: isPublic }) => {
        try {
          const owner = ownerOf(ctx);
          if (!owner) return { error: "This run has no project or conversation to open the preview in." };
          if (!ctx.sandbox) return NO_SANDBOX;
          const workspace = await ctx.sandbox.workspace();
          const address = await currentSandboxBackend()?.addressOf(workspace.key);
          if (!address || !(await answers(address, port))) {
            return {
              error: `Nothing answers on port ${port}. Start the app in the background listening on 0.0.0.0 (not 127.0.0.1), check it with curl, then call preview_open again.`,
            };
          }
          const preview = await createLivePreview({
            owner,
            workspaceKey: workspace.key,
            port,
            title,
            public: isPublic,
            agentId: ctx.agent.id,
            runId: ctx.run.id,
          });
          return describe(preview);
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
};
