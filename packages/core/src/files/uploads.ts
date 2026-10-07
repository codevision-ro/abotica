import path from "node:path";
import { env } from "../infra/env";

let defaultRoot: string | undefined;

/**
 * Where stored files live when UPLOADS_DIR is not set, for a process that does not run from the
 * web app folder: the worker points it at the web app's .data/uploads.
 */
export function setDefaultUploadsRoot(dir: string): void {
  defaultRoot = path.resolve(dir);
}

/**
 * Root for stored files: UPLOADS_DIR, else the default root, else .data/uploads under the
 * current folder (the web app). The magic comment keeps Turbopack from tracing the whole project.
 * Always absolute and without a trailing slash, which resolveUpload's prefix check relies on.
 */
export const uploadsRoot = () => {
  const configured = env().UPLOADS_DIR ?? defaultRoot;
  return configured ? path.resolve(configured) : path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "uploads");
};

/** Absolute path for a stored relative path, or null if it escapes the uploads root. */
export function resolveUpload(relative: string): string | null {
  const root = uploadsRoot();
  const file = path.resolve(root, relative);
  return file.startsWith(root + path.sep) ? file : null;
}
