import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { SubscriptionAccount } from "@abotica/db";
import type { CatalogModel } from "../catalog";

/** The credentials of one signed-in account; kept encrypted at rest. */
export type SubscriptionTokens = {
  accessToken: string;
  refreshToken: string | null;
  /** Retained to identify the account on a later sign-in. */
  idToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
};

/** A model the account may use; what it leaves out comes from models.dev. */
export type SubscriptionModel = Pick<CatalogModel, "id" | "name"> &
  Partial<Pick<CatalogModel, "reasoning" | "input" | "contextWindow" | "toolCall">>;

/** Everything one authorization attempt needs to build its URL; the generic flow owns the values. */
type AuthorizationRequest = {
  /** Null on the first sign-in, when the provider registers a client dynamically. */
  clientId: string | null;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  /** From the previous sign-in, so the provider can skip its account picker. */
  idTokenHint: string | null;
  loginHint: string | null;
  /** Show the consent screen even for a known client, e.g. after the user declined plan use. */
  forceConsent: boolean;
};

type CodeExchange = {
  /** The client the authorization was started with, or the one the callback reports for a new registration. */
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  nonce: string;
};

export type SignedIn = { clientId: string; account: SubscriptionAccount; tokens: SubscriptionTokens };

/** The account accepted the sign-in but did not grant use of its plan; there is nothing to call with. */
export class PlanNotGrantedError extends Error {
  constructor() {
    super("The account did not allow this app to use its plan");
    this.name = "PlanNotGrantedError";
  }
}

/** The provider no longer recognizes the issued client; the next sign-in registers a new one. */
export class InvalidClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClientError";
  }
}

/** The refresh token can no longer be used; the user has to sign in again. */
export class SignInRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRequiredError";
  }
}

/**
 * One way to bill models to a user's own plan. The generic flow (state, PKCE, storage, refresh
 * serialization, the callback route) lives in this folder; an implementation only speaks its
 * provider's OAuth dialect and builds the model.
 */
export interface SubscriptionProvider {
  /** Where the user reviews usage and limits for this app. */
  usageUrl: string;
  /**
   * Path of the loopback callback the provider redirects to (`http://127.0.0.1:<port><path>`).
   * The web app serves it, so a sign-in from the machine the app runs on completes on its own.
   */
  callbackPath: string;
  /** The callback port when the app is not reached over loopback; the user pastes the address back. */
  fallbackPort: number;
  authorizationUrl(request: AuthorizationRequest): string;
  /**
   * The issued client of a new registration, when the callback reports it.
   * `null` keeps the client the attempt was started with.
   */
  callbackClientId(params: URLSearchParams): string | null;
  exchangeCode(exchange: CodeExchange): Promise<SignedIn>;
  /** Throws `SignInRequiredError` when the refresh token is no longer accepted. */
  refresh(input: { clientId: string; refreshToken: string }): Promise<SubscriptionTokens>;
  /** Ends the renewable session at the provider; best effort, the tokens are dropped either way. */
  revoke(input: { clientId: string; refreshToken: string }): Promise<void>;
  listModels(accessToken: string): Promise<SubscriptionModel[]>;
  /** `accessToken` is valid for at least a few minutes; the model is built per call. */
  languageModel(accessToken: string, model: string): LanguageModelV4;
}
