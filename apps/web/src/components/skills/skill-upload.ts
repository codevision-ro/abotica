import { SKILL_MAX_FILE_BYTES } from "@abotica/core/limits";
import { packageSkillFiles, SKILL_MD, type SkillFileEntry, type SkillPackage } from "@abotica/core/skill-md";
import { unzipSync } from "fflate";

/** A skill read from the user's computer, packaged but not stored yet. */
export type LocalSkill = {
  pkg: SkillPackage;
  /** Files left out: binary, too large or outside the skill folder. */
  skipped: string[];
  /** What the user picked: the zip, folder or file name. */
  label: string;
};

type PickedFile = { path: string; file: File };

/** OS and VCS leftovers that are never part of a skill; dropped without a mention. */
const JUNK = /(^|\/)(__MACOSX|\.git|node_modules)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)$/;

const MARKDOWN = /\.(md|markdown)$/i;

/** Files from the file or folder picker (folder uploads carry their relative path). */
export function readPickedSkill(files: FileList): Promise<LocalSkill | null> {
  return readSkill([...files].map((file) => ({ path: file.webkitRelativePath || file.name, file })));
}

/**
 * A drop of a zip, a folder or loose files. The entries are taken before the first await:
 * the browser empties `dataTransfer` once the drop event returns.
 */
export async function readDroppedSkill(data: DataTransfer): Promise<LocalSkill | null> {
  const entries = [...data.items].flatMap((item) => item.webkitGetAsEntry() ?? []);
  const files = entries.length
    ? (await Promise.all(entries.map(walkEntry))).flat()
    : [...data.files].map((file) => ({ path: file.name, file }));
  return readSkill(files);
}

async function walkEntry(entry: FileSystemEntry): Promise<PickedFile[]> {
  const path = entry.fullPath.replace(/^\//, "");
  if (JUNK.test(path)) return [];
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    return [{ path, file }];
  }
  if (!entry.isDirectory) return [];
  // readEntries returns the children in batches; an empty batch means the end.
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map(walkEntry))).flat();
}

async function readSkill(picked: PickedFile[]): Promise<LocalSkill | null> {
  const kept = picked.filter((f) => !JUNK.test(f.path));
  const single = kept.length === 1 ? kept[0]! : null;
  const raw: SkillFileEntry[] = [];
  const skipped: string[] = [];
  let label = topFolder(kept.map((f) => f.path));
  // The skill's name when SKILL.md has none: the folder, zip or file name.
  let fallbackName = label;

  if (single && /\.zip$/i.test(single.path)) {
    label = fileName(single.path);
    fallbackName = baseName(label);
    const entries = unzipSync(new Uint8Array(await single.file.arrayBuffer()), {
      filter: (f) => {
        if (f.name.endsWith("/") || JUNK.test(f.name)) return false;
        if (f.originalSize <= SKILL_MAX_FILE_BYTES) return true;
        skipped.push(f.name);
        return false;
      },
    });
    for (const [path, bytes] of Object.entries(entries)) addDecoded(raw, skipped, path, bytes);
  } else if (single && MARKDOWN.test(single.path)) {
    // A lone markdown file is the SKILL.md, whatever it is called.
    label = fileName(single.path);
    if (label !== SKILL_MD) fallbackName = baseName(label);
    addDecoded(raw, skipped, SKILL_MD, new Uint8Array(await single.file.arrayBuffer()));
  } else {
    for (const { path, file } of kept) {
      if (file.size > SKILL_MAX_FILE_BYTES) skipped.push(path);
      else addDecoded(raw, skipped, path, new Uint8Array(await file.arrayBuffer()));
    }
  }

  const packaged = packageSkillFiles(raw);
  if (!packaged) return null;
  const pkg = { ...packaged.pkg, name: packaged.pkg.name || fallbackName };
  return { pkg, skipped: [...skipped, ...packaged.skipped], label: label || SKILL_MD };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Text files only: bytes that are not valid UTF-8 mean a binary file. */
function addDecoded(raw: SkillFileEntry[], skipped: string[], path: string, bytes: Uint8Array) {
  try {
    raw.push({ path, content: utf8.decode(bytes) });
  } catch {
    skipped.push(path);
  }
}

/** The folder every path sits in, when they share one ("my-skill/SKILL.md" -> "my-skill"). */
function topFolder(paths: string[]): string {
  const first = paths[0]?.split("/");
  if (!first || first.length < 2) return "";
  return paths.every((p) => p.startsWith(`${first[0]}/`)) ? first[0]! : "";
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
