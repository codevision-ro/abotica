"use client";

import { compareSkillPaths, SKILL_MD } from "@abotica/core/skill-md";
import {
  ChevronRightIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  ScrollTextIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

export const byteLength = (s: string) => new TextEncoder().encode(s).length;

type TreeNode = { name: string; path: string; children: TreeNode[] | null };

/** Nested folders from flat paths, in the editor's order: SKILL.md first, folders before files. */
function buildSkillTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const path of [...paths].sort(compareSkillPaths)) {
    const parts = path.split("/");
    let level = root;
    parts.forEach((name, i) => {
      const nodePath = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;
      let node = level.find((n) => n.name === name && (n.children === null) === isFile);
      if (!node) {
        node = { name, path: nodePath, children: isFile ? null : [] };
        level.push(node);
      }
      if (node.children) level = node.children;
    });
  }
  return root;
}

const CODE_EXTENSIONS = new Set([
  "py",
  "js",
  "ts",
  "mjs",
  "cjs",
  "tsx",
  "jsx",
  "sh",
  "bash",
  "json",
  "yaml",
  "yml",
  "toml",
  "sql",
  "rb",
  "go",
  "rs",
  "html",
  "css",
  "xml",
]);

export function skillFileIcon(path: string): LucideIcon {
  if (path === SKILL_MD) return ScrollTextIcon;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown" || ext === "txt") return FileTextIcon;
  return CODE_EXTENSIONS.has(ext) ? FileCodeIcon : FileIcon;
}

/**
 * The files of a skill as a collapsible tree. Folders start open; arrow keys move between rows,
 * Left/Right close and open folders.
 */
export function SkillFileTree({
  paths,
  selected,
  onSelect,
  marks,
  label,
  className,
}: {
  paths: string[];
  selected: string | null;
  onSelect: (path: string) => void;
  /** Small trailing marker per path, e.g. a dot for unsaved or a status letter in a diff. */
  marks?: Record<string, React.ReactNode>;
  /** Accessible name of the tree. */
  label: string;
  className?: string;
}) {
  const tree = useMemo(() => buildSkillTree(paths), [paths]);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLUListElement>(null);

  const toggle = (path: string, open?: boolean) =>
    setClosed((prev) => {
      const next = new Set(prev);
      const isOpen = !next.has(path);
      if (open ?? !isOpen) next.delete(path);
      else next.add(path);
      return next;
    });

  function onKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[index + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }

  function renderNodes(nodes: TreeNode[], depth: number): React.ReactNode {
    return nodes.map((node) => {
      const indent = { paddingLeft: `${0.5 + depth * 0.875}rem` };
      if (node.children) {
        const open = !closed.has(node.path);
        const Icon = open ? FolderOpenIcon : FolderIcon;
        return (
          <li key={`d:${node.path}`} role="treeitem" aria-expanded={open} aria-selected={false}>
            <button
              type="button"
              data-tree-row
              onClick={() => toggle(node.path)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" && !open) toggle(node.path, true);
                if (e.key === "ArrowLeft" && open) toggle(node.path, false);
              }}
              style={indent}
              className="flex h-8 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
            {open && (
              <ul role="group" className="flex flex-col">
                {renderNodes(node.children, depth + 1)}
              </ul>
            )}
          </li>
        );
      }
      const Icon = skillFileIcon(node.path);
      const active = node.path === selected;
      return (
        <li key={`f:${node.path}`} role="treeitem" aria-selected={active} className="group/row relative flex items-center">
          <button
            type="button"
            data-tree-row
            onClick={() => onSelect(node.path)}
            style={{ paddingLeft: `${0.5 + depth * 0.875 + 1.125}rem` }}
            title={node.path}
            className={cn(
              "flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md pr-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active
                ? "bg-primary/8 font-medium text-foreground dark:bg-primary/15"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <Icon aria-hidden className={cn("size-4 shrink-0", active && "text-primary")} />
            <span className="truncate">{node.name}</span>
            {marks?.[node.path] && <span className="ml-auto shrink-0 pl-1">{marks[node.path]}</span>}
          </button>
        </li>
      );
    });
  }

  return (
    <ul ref={listRef} role="tree" aria-label={label} onKeyDown={onKeyDown} className={cn("flex flex-col", className)}>
      {renderNodes(tree, 0)}
    </ul>
  );
}
