/**
 * ChatGPT plan usage through Sign in with ChatGPT, for open-source and self-hosted apps (preview).
 * The user signs in, registers Abotica as an agent and allows it to use their plan; calls then go to
 * the public Responses API with the OAuth access token instead of an API key.
 * https://developers.openai.com/siwc/token-sharing-open-source
 */
import { createOpenAI } from "@ai-sdk/openai";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { supportFromEfforts } from "../reasoning";
import { planFetch } from "./chatgpt-request";
import {
  InvalidClientError,
  PlanNotGrantedError,
  SignInRequiredError,
  type SubscriptionModel,
  type SubscriptionProvider,
  type SubscriptionTokens,
} from "./types";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const API_URL = "https://api.openai.com/v1";

/** The scope that allows calls on the user's plan; the others are identity and refresh. */
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", PLAN_SCOPE];

/** The client id of a first sign-in, which registers this installation's own client. */
const REGISTRATION_CLIENT = "dynamic_agent_client";
/** Shown to the user when they approve the agent; the same on every installation. */
const AGENT_NAME = "Abotica";

/** Refresh errors after which the token is gone for good and the user must sign in again. */
const SIGN_IN_AGAIN = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
};

type OAuthError = { error?: string | { code?: string; message?: string }; error_description?: string };

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

const tokens = (body: TokenResponse): SubscriptionTokens => ({
  accessToken: body.access_token,
  refreshToken: body.refresh_token ?? null,
  idToken: body.id_token ?? null,
  expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
  scopes: body.scope?.split(" ").filter(Boolean) ?? [],
});

/** Form-encoded POST to an auth endpoint; returns the JSON body or throws with the OAuth error code. */
async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error_description: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

function oauthError(status: number, body: unknown): { code: string | null; message: string } {
  const e = (body ?? {}) as OAuthError;
  const code = typeof e.error === "string" ? e.error : (e.error?.code ?? null);
  const detail = e.error_description ?? (typeof e.error === "object" ? e.error.message : undefined);
  return { code, message: `OpenAI sign-in responded ${status}${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}` };
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const { status, body } = await postForm(TOKEN_URL, { ...form, resource: API_URL });
  if (status === 200) return body as TokenResponse;
  const { code, message } = oauthError(status, body);
  if (code === "invalid_client") throw new InvalidClientError(message);
  if (form.grant_type === "refresh_token" && code && SIGN_IN_AGAIN.has(code)) throw new SignInRequiredError(message);
  throw new Error(message);
}

/** The fields of the account's model catalog this app reads. */
type PlanModel = {
  slug: string;
  display_name?: string;
  visibility?: string;
  input_modalities?: string[];
  context_window?: number;
  supported_reasoning_levels?: { effort: string }[];
};

export const chatgpt: SubscriptionProvider = {
  usageUrl: "https://chatgpt.com/settings/usage",
  callbackPath: "/auth/callback",
  fallbackPort: 1455,

  authorizationUrl(request) {
    const url = new URL(AUTHORIZE_URL);
    const params = url.searchParams;
    params.set("client_id", request.clientId ?? REGISTRATION_CLIENT);
    // The name goes only with a new registration; the user can edit it before approving.
    if (!request.clientId) params.set("agent_name_hint", AGENT_NAME);
    params.set("ext_agent_host_id", request.hostId);
    if (request.idTokenHint) params.set("id_token_hint", request.idTokenHint);
    if (request.loginHint) params.set("login_hint", request.loginHint);
    if (request.forceConsent) params.set("prompt", "consent");
    params.set("response_type", "code");
    params.set("redirect_uri", request.redirectUri);
    params.set("scope", SCOPES.join(" "));
    params.set("resource", API_URL);
    params.set("state", request.state);
    params.set("nonce", request.nonce);
    params.set("code_challenge_method", "S256");
    params.set("code_challenge", request.codeChallenge);
    return url.href;
  },

  callbackClientId: (params) => params.get("client_id"),

  async exchangeCode({ clientId, code, codeVerifier, redirectUri, nonce }) {
    const body = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    });
    if (!body.id_token) throw new Error("OpenAI sign-in returned no ID token");
    jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
    const { payload } = await jwtVerify(body.id_token, jwks, { issuer: ISSUER, audience: clientId });
    if (payload.nonce !== nonce) throw new Error("The ID token does not belong to this sign-in");
    const granted = tokens(body);
    // A valid identity alone does not allow calls on the plan.
    if (!granted.scopes.includes(PLAN_SCOPE)) throw new PlanNotGrantedError();
    return {
      clientId,
      tokens: granted,
      account: {
        subject: payload.sub!,
        email: typeof payload.email === "string" ? payload.email : null,
        name: typeof payload.name === "string" ? payload.name : null,
      },
    };
  },

  async refresh({ clientId, refreshToken }) {
    return tokens(await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }));
  },

  async revoke({ clientId, refreshToken }) {
    const { status, body } = await postForm(REVOKE_URL, {
      token: refreshToken,
      token_type_hint: "refresh_token",
      client_id: clientId,
    });
    if (status !== 200) throw new Error(oauthError(status, body).message);
  },

  async listModels(accessToken) {
    const res = await fetch(`${API_URL}/models`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`ChatGPT models responded ${res.status}`);
    const data = (await res.json()) as { models?: PlanModel[] };
    // Kept in the server's order; "hide" marks models not meant for a picker.
    return (data.models ?? [])
      .filter((m) => m.visibility === "list")
      .map((m): SubscriptionModel => ({
        id: m.slug,
        name: m.display_name ?? m.slug,
        toolCall: true,
        ...(m.input_modalities && { input: m.input_modalities }),
        ...(m.context_window && { contextWindow: m.context_window }),
        ...(m.supported_reasoning_levels && {
          reasoning: supportFromEfforts(m.supported_reasoning_levels.map((l) => l.effort)),
        }),
      }));
  },

  languageModel(accessToken, model) {
    return createOpenAI({ apiKey: accessToken, fetch: planFetch }).responses(model);
  },
};
