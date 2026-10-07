import { type SkillPackage, skillPackageFiles } from "@abotica/core/skill-md";
import { strToU8, zipSync } from "fflate";

/** Downloads the skill as `<slug>.zip`: one `<slug>/` folder with SKILL.md (frontmatter included) and the other files. */
export function downloadSkillZip(pkg: SkillPackage, slug: string) {
  const folder = slug || "skill";
  const zip = zipSync(Object.fromEntries(skillPackageFiles(pkg).map((f) => [`${folder}/${f.path}`, strToU8(f.content)])));
  const url = URL.createObjectURL(new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${folder}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}
