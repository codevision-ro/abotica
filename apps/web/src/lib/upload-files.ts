/** A stored file as `POST /api/files` returns it: a pending upload until a message, task or knowledge item claims it. */
export type UploadedFile = { id: string; url: string; name: string; mediaType: string; size: number };

type UploadOptions = {
  /** Share of all bytes sent so far, 0 to 1. */
  onProgress?: (fraction: number) => void;
  /** Message for a failure the server did not explain (network down, aborted). */
  fallbackError: string;
  /** Called after each file is stored, so a caller can reuse it if a later file fails. */
  onUploaded?: (index: number, file: UploadedFile) => void;
};

/** One file per request, so the server holds at most one file in memory and progress is per byte. */
function uploadOne(data: Blob, name: string, onProgress: (loaded: number) => void, fallbackError: string) {
  return new Promise<UploadedFile>((resolve, reject) => {
    // fetch() cannot report upload progress; XMLHttpRequest can.
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (e) => onProgress(e.loaded));
    xhr.addEventListener("load", () => {
      const body = xhr.response as { files?: UploadedFile[]; error?: string } | null;
      const file = body?.files?.[0];
      if (xhr.status >= 200 && xhr.status < 300 && file) resolve(file);
      else reject(new Error(body?.error || fallbackError));
    });
    xhr.addEventListener("error", () => reject(new Error(fallbackError)));
    xhr.addEventListener("abort", () => reject(new Error(fallbackError)));
    const form = new FormData();
    form.append("file", data, name);
    xhr.send(form);
  });
}

/**
 * Uploads files one after another; rejects with the server's translated message on the first
 * failure. Files uploaded before it stay pending (see `onUploaded`) and are swept if never claimed.
 */
export async function uploadFiles(
  files: { data: Blob; name: string }[],
  { onProgress, fallbackError, onUploaded }: UploadOptions,
): Promise<UploadedFile[]> {
  const total = files.reduce((sum, f) => sum + f.data.size, 0) || 1;
  let done = 0;
  const uploaded: UploadedFile[] = [];
  onProgress?.(0);
  for (const [index, file] of files.entries()) {
    const stored = await uploadOne(
      file.data,
      file.name,
      (loaded) => onProgress?.(Math.min(1, (done + Math.min(loaded, file.data.size)) / total)),
      fallbackError,
    );
    uploaded.push(stored);
    onUploaded?.(index, stored);
    done += file.data.size;
    onProgress?.(done / total);
  }
  return uploaded;
}
