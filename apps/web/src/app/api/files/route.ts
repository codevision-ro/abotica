import { FILE_MAX_BYTES, fileUrl, saveFile } from "@abotica/core";
import { getTranslator, isUserError, translateKey } from "@abotica/i18n";
import { getLocale } from "next-intl/server";
import type { UploadedFile } from "@/lib/upload-files";
import { isCrossOriginWrite } from "@/server/same-origin";
import { requireApiUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * Uploads files (multipart, field `file`, one or more) as pending uploads; a chat message, a task or
 * a knowledge item claims them afterwards. Answers `{ files }`, or `{ error }` with a translated message.
 *
 * The body is buffered, not streamed to disk: `saveFile` takes the bytes, the app has a single user,
 * files are capped at FILE_MAX_BYTES (50 MB) and the web client sends one file per request, so a
 * request holds at most one file in memory. The route is outside the proxy matcher, so the proxy does
 * not buffer (and cut) the body a second time.
 */
export async function POST(request: Request) {
  // Outside the proxy matcher, so the cross-origin check happens here.
  if (isCrossOriginWrite(request)) return new Response("Cross-origin request refused", { status: 403 });
  try {
    await requireApiUser();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  const t = getTranslator(await getLocale());
  const fail = (key: string, values?: Record<string, string | number>, status = 400) =>
    Response.json({ error: translateKey(t, key, values) }, { status });

  const form = await request.formData().catch(() => null);
  const uploads = (form?.getAll("file") ?? []).filter((f): f is File => f instanceof File);
  if (!uploads.length) return fail("files.errors.noFiles");
  // Check every file before storing any, so a rejected request leaves nothing behind.
  for (const file of uploads) {
    if (!file.size) return fail("files.errors.empty", { name: file.name });
    if (file.size > FILE_MAX_BYTES) {
      return fail("files.errors.tooLarge", { name: file.name, max: FILE_MAX_BYTES / (1024 * 1024) }, 413);
    }
  }

  try {
    const saved: UploadedFile[] = [];
    for (const file of uploads) {
      const row = await saveFile({
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
        source: "user",
        owner: null,
        mimeType: file.type,
      });
      saved.push({ id: row.id, url: fileUrl(row.id), name: row.name, mediaType: row.mimeType, size: row.size });
    }
    return Response.json({ files: saved });
  } catch (error) {
    if (isUserError(error)) return fail(error.key, error.values);
    throw error;
  }
}
