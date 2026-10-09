import "server-only";
import { getPreview as findPreview, listPreviews, type Preview, previewUrl } from "@abotica/core";
import { conversations, db } from "@abotica/db";
import { inArray } from "@abotica/db/orm";
import { getProjectNames } from "./projects";
import { query } from "@/server/query";

/** A preview as the list shows it, with where it came from. */
export type PreviewRow = {
  id: string;
  title: string;
  kind: Preview["kind"];
  public: boolean;
  expiresAt: Date;
  createdAt: Date;
  /** The preview's own address, for public links and copying. */
  url: string;
  /** Opens it for the signed-in user, private ones included. */
  openHref: string;
  owner: { kind: "project" | "conversation"; name: string; href: string };
};

/** Active previews, newest first: of a project, or all of them. */
export const listPreviewRows = query(async (projectId?: string): Promise<PreviewRow[]> => {
  const rows = await listPreviews(projectId ? { projectId } : undefined);
  const conversationIds = [...new Set(rows.flatMap((p) => (p.conversationId ? [p.conversationId] : [])))];
  const [projectNames, conversationRows] = await Promise.all([
    getProjectNames(rows.map((p) => p.projectId)),
    conversationIds.length
      ? db
          .select({ id: conversations.id, title: conversations.title })
          .from(conversations)
          .where(inArray(conversations.id, conversationIds))
      : [],
  ]);
  const conversationTitles = new Map(conversationRows.map((c) => [c.id, c.title]));
  return rows.map((preview) => ({
    id: preview.id,
    title: preview.title,
    kind: preview.kind,
    public: preview.public,
    expiresAt: preview.expiresAt,
    createdAt: preview.createdAt,
    url: previewUrl(preview),
    openHref: `/preview/${preview.id}`,
    owner: preview.projectId
      ? { kind: "project", name: projectNames.get(preview.projectId) ?? "", href: `/projects/${preview.projectId}` }
      : {
          kind: "conversation",
          name: conversationTitles.get(preview.conversationId!) ?? "",
          href: `/chat/${preview.conversationId}`,
        },
  }));
});

/** One preview, for the route that lets the user into a private one. */
export const getPreview = query((id: string) => findPreview(id));
