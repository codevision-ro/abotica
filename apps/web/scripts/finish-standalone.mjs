/**
 * Completes the standalone server after `next build`: its static assets and public/ (Next leaves them out),
 * and undici under its own name. The AI SDK loads undici at runtime with createRequire (safe downloads in
 * @ai-sdk/provider-utils), a require the bundler cannot see: Next exposes external packages only under
 * hashed names, so without this the require fails in the image ("Cannot find module 'undici'").
 * undici has no dependencies, so its folder is enough.
 */
import { cpSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");
const server = path.join(web, ".next/standalone/apps/web");

cpSync(path.join(web, ".next/static"), path.join(server, ".next/static"), { recursive: true });
cpSync(path.join(web, "public"), path.join(server, "public"), { recursive: true });

const undici = path.dirname(realpathSync(createRequire(import.meta.url).resolve("undici/package.json")));
cpSync(undici, path.join(server, "node_modules/undici"), { recursive: true, dereference: true });
