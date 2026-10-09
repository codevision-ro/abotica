import { env } from "../infra/env";
import { reachableUrl } from "../infra/reachable-url";
import { getSettings } from "../settings/settings";

/** The Ollama server from Settings, as this process reaches it (in a container, localhost is the host). */
export async function ollamaBase(): Promise<string> {
  return reachableUrl((await getSettings()).models.ollama.baseUrl, env().HOST_GATEWAY);
}
