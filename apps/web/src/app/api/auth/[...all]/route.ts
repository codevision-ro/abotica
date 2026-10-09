import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";

export const { GET, POST } = toNextJsHandler(async (request) => (await getAuth()).handler(request));
