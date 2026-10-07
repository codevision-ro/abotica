/**
 * Bundles live in a root-owned tmpfs at /opt/abotica/bundles, readable but not writable by the
 * sandbox user. A state file there maps bundle names to hashes, so only changed bundles are
 * rewritten; a container restart empties the tmpfs and the state with it, so bundles nobody lists
 * anymore are gone after the next restart.
 */
import type { Bundle } from "../types";
import { createTar, type TarEntry } from "./tar";

export const BUNDLE_STATE_FILE = ".abotica-bundles.json";

export type BundleState = Record<string, string>;

// Skill slugs can be 64 characters.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Throws when a bundle name or file path could escape its folder. */
export function assertBundle(bundle: Bundle): void {
  if (!NAME_RE.test(bundle.name)) throw new Error(`Invalid bundle name: ${JSON.stringify(bundle.name)}`);
  for (const file of bundle.files) {
    const segments = file.path.split("/");
    const valid =
      file.path.length > 0 &&
      !file.path.includes("\0") &&
      segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
    if (!valid) throw new Error(`Invalid file path in bundle ${bundle.name}: ${JSON.stringify(file.path)}`);
  }
}

export function parseBundleState(text: string): BundleState {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => NAME_RE.test(entry[0]) && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export type BundlePlan = {
  /** Bundles to (re)write. */
  write: Bundle[];
  /** Folders to delete before extracting: the old copy of rewritten bundles. */
  remove: string[];
  /** State after the sync. */
  state: BundleState;
};

/**
 * What to change so the container holds `desired`: new and changed bundles are written, nothing is
 * removed. Several runs may share a workspace, each with its own skills, so a bundle another run
 * listed stays until the container restarts (the tmpfs starts empty again).
 */
export function planBundleSync(current: BundleState, desired: Bundle[]): BundlePlan {
  const write = [...new Map(desired.map((bundle) => [bundle.name, bundle])).values()].filter(
    (bundle) => current[bundle.name] !== bundle.hash,
  );
  const state: BundleState = { ...current };
  for (const bundle of write) state[bundle.name] = bundle.hash;
  return { write, remove: write.filter((bundle) => bundle.name in current).map((bundle) => bundle.name), state };
}

export const planIsEmpty = (plan: BundlePlan) => plan.write.length === 0 && plan.remove.length === 0;

/** Tar of the bundles to write plus the new state file, paths relative to the bundles folder. */
export function bundleTar(plan: BundlePlan): Buffer {
  const entries: TarEntry[] = [];
  for (const bundle of plan.write) {
    const dirs = new Set<string>([bundle.name]);
    for (const file of bundle.files) {
      const segments = file.path.split("/");
      for (let i = 1; i < segments.length; i++) dirs.add(`${bundle.name}/${segments.slice(0, i).join("/")}`);
    }
    for (const dir of [...dirs].sort()) entries.push({ type: "directory", path: dir, mode: 0o755 });
    for (const file of bundle.files) {
      const content = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : file.content;
      entries.push({ type: "file", path: `${bundle.name}/${file.path}`, mode: file.executable ? 0o755 : 0o644, content });
    }
  }
  entries.push({ type: "file", path: BUNDLE_STATE_FILE, mode: 0o644, content: Buffer.from(JSON.stringify(plan.state)) });
  return createTar(entries);
}
