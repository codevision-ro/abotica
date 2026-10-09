import "server-only";
import { getOfficeState } from "@abotica/core";
import { query } from "@/server/query";

/** The office: rooms, who sits where doing what, and the latest interactions between agents. */
export const getOffice = query(async () => getOfficeState());
