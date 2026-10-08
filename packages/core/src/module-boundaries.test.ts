import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Core modules that client components import at runtime (CONTRIBUTING.md, "Where code goes"), as paths
 * under src/; the package exports them under their file name (package.json "exports").
 * They and everything they import must stay free of server-only code (database, Redis, env, node:*).
 */
const CLIENT_SAFE = [
  "agents/permissions",
  "agents/tools/tool-catalog",
  "agents/untrusted",
  "automations/cron",
  "automations/trigger-events",
  "files/file-types",
  "mcp/mcp-builtins",
  "mcp/mcp-stored-values",
  "models/reasoning",
  "platform/audit-actions",
  "platform/limits",
  "platform/return-path",
  "platform/slug",
  "runs/compaction-record",
  "sandbox/sandbox-policy",
  "skills/skill-md",
  "tasks/delegation-report",
  "tasks/wakeup-rules",
  "telegram/telegram-ids",
];

/** Packages a client-safe module may import at runtime. */
const ALLOWED_PACKAGES = new Set(["@abotica/i18n", "@abotica/db/avatar", "yaml", "zod"]);

const SRC = import.meta.dirname;

/** Runtime import specifiers of a file: type-only imports and exports are erased, so they do not count. */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)
          : false);
      if (!typeOnly) specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const named = statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause : null;
      const typeOnly =
        statement.isTypeOnly || (named !== null && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return specifiers;
}

/** The source file a relative specifier points to. */
function resolveRelative(from: string, specifier: string): string {
  const base = join(dirname(from), specifier);
  return existsSync(`${base}.ts`) ? `${base}.ts` : join(base, "index.ts");
}

function serverOnlyImports(entry: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith(".")) visit(resolveRelative(file, specifier));
      else if (!ALLOWED_PACKAGES.has(specifier)) problems.push(`${relative(SRC, file)} imports ${specifier}`);
    }
  };
  visit(join(SRC, `${entry}.ts`));
  return problems;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Runtime import cycles between core modules, each as the chain of files that closes it. */
function importCycles(): string[][] {
  const graph = new Map(
    sourceFiles(SRC).map((file) => [
      file,
      runtimeImports(file)
        .filter((specifier) => specifier.startsWith("."))
        .map((specifier) => resolveRelative(file, specifier)),
    ]),
  );
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (file: string) => {
    state.set(file, "visiting");
    stack.push(file);
    for (const next of graph.get(file) ?? []) {
      if (state.get(next) === "visiting")
        cycles.push([...stack.slice(stack.indexOf(next)), next].map((f) => relative(SRC, f)));
      else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(file, "done");
  };
  for (const file of graph.keys()) if (!state.has(file)) visit(file);
  return cycles;
}

describe("client-safe core modules", () => {
  it.each(CLIENT_SAFE)("%s has no server-only runtime imports", (entry) => {
    expect(serverOnlyImports(entry)).toEqual([]);
  });
});

describe("core module graph", () => {
  // A cycle makes module initialization order-dependent; split the shared part out instead.
  it("has no runtime import cycles", () => {
    expect(importCycles()).toEqual([]);
  });
});
