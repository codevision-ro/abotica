import "server-only";
import { getFile } from "@abotica/core";
import { query } from "@/server/query";

/** A stored file's row (name, type, owner), for the download route. */
export const getStoredFile = query((id: string) => getFile(id));
