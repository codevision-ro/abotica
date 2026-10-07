import { env } from "../infra/env";

export const originOf = (value: string): string | null => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

/** Origins the app is served from: APP_URL first, then TRUSTED_ORIGINS (tunnels, a second domain). */
export function appOrigins(): string[] {
  const configured = [env().APP_URL, ...(env().TRUSTED_ORIGINS ?? "").split(",")];
  return [...new Set(configured.map((o) => originOf(o.trim())).filter((o): o is string => o !== null))];
}

/**
 * `origin` when it is one of the app's own origins, APP_URL otherwise: a redirect built from it
 * can never send the user (or a code) to a forged address.
 */
export function trustedAppOrigin(origin?: string | null): string {
  const origins = appOrigins();
  const requested = origin ? originOf(origin) : null;
  return requested && origins.includes(requested) ? requested : origins[0]!;
}
