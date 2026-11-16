/**
 * A small client for Clerk's Frontend API (FAPI): just what ADE's own sign-in
 * card needs (email code, Google / GitHub / Apple, sign-up, the session list).
 *
 * Clerk's browser SDK does the same work but costs ~570 KB gzipped and pulls
 * crypto-wallet and Stripe packages ADE never uses, so this follows the SDK's
 * wire rules by hand (clerk/javascript `packages/clerk-js/src/core/fapiClient.ts`):
 *  - form-encoded bodies, `credentials: "include"` (the `__client` cookie lives
 *    on the FAPI host, which is same-site with app.ade-app.dev);
 *  - only GET and POST on the wire, any other verb as `_method` (Safari drops
 *    cookies on a CORS preflight);
 *  - `__clerk_api_version` pins the response shapes;
 *  - a development instance has no cookies across sites, so it carries a
 *    "dev browser" id in `__clerk_db_jwt` instead.
 *
 * Shapes are read defensively: a field Clerk renames reads as missing, and the
 * card falls back to Clerk's own hosted page.
 */

const CLERK_API_VERSION = "2025-11-10";
const DEV_BROWSER_KEY = "ade-web:clerk-dev-browser";
const DEV_BROWSER_PARAM = "__clerk_db_jwt";
const REQUEST_TIMEOUT_MS = 15_000;

export type ClerkFactor = {
  strategy: string;
  emailAddressId: string | null;
  safeIdentifier: string | null;
};

export type ClerkVerification = {
  status: string | null;
  strategy: string | null;
  externalVerificationRedirectUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorSessionId: string | null;
};

export type ClerkSignIn = {
  id: string;
  status: string | null;
  supportedFirstFactors: ClerkFactor[];
  firstFactorVerification: ClerkVerification;
  createdSessionId: string | null;
};

export type ClerkSignUp = {
  id: string;
  status: string | null;
  missingFields: string[];
  externalAccountVerification: ClerkVerification;
  createdSessionId: string | null;
};

export type ClerkSessionSummary = {
  id: string;
  status: string | null;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
};

export type ClerkClientState = {
  sessions: ClerkSessionSummary[];
  lastActiveSessionId: string | null;
  signIn: ClerkSignIn | null;
  signUp: ClerkSignUp | null;
  captchaBypass: boolean;
};

export type ClerkEnvironment = {
  /** `oauth_google`, `oauth_github`, `oauth_apple`, … in the order Clerk lists them. */
  socialStrategies: string[];
  emailCodeEnabled: boolean;
  signUpCaptchaEnabled: boolean;
  captchaProvider: string | null;
  captchaSiteKey: string | null;
  captchaInvisibleSiteKey: string | null;
  captchaWidgetType: string | null;
  /** Strategies whose OAuth sign-ups skip the captcha (the provider vouches). */
  captchaOauthBypass: string[];
};

export class ClerkApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly meta: Record<string, unknown>;

  constructor(args: { code: string; message: string; status: number; meta?: Record<string, unknown> }) {
    super(args.message);
    this.name = "ClerkApiError";
    this.code = args.code;
    this.status = args.status;
    this.meta = args.meta ?? {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseVerification(value: unknown): ClerkVerification {
  const v = isRecord(value) ? value : {};
  const error = isRecord(v.error) ? v.error : {};
  const meta = isRecord(error.meta) ? error.meta : {};
  return {
    status: str(v.status),
    strategy: str(v.strategy),
    externalVerificationRedirectUrl: str(v.external_verification_redirect_url),
    errorCode: str(error.code),
    errorMessage: str(error.long_message) ?? str(error.message),
    errorSessionId: str(meta.session_id),
  };
}

function parseSignIn(value: unknown): ClerkSignIn | null {
  const id = isRecord(value) ? str(value.id) : null;
  if (!isRecord(value) || !id) return null;
  const factors = Array.isArray(value.supported_first_factors) ? value.supported_first_factors : [];
  return {
    id,
    status: str(value.status),
    supportedFirstFactors: factors.filter(isRecord).map((factor) => ({
      strategy: str(factor.strategy) ?? "",
      emailAddressId: str(factor.email_address_id),
      safeIdentifier: str(factor.safe_identifier),
    })),
    firstFactorVerification: parseVerification(value.first_factor_verification),
    createdSessionId: str(value.created_session_id),
  };
}

function parseSignUp(value: unknown): ClerkSignUp | null {
  const id = isRecord(value) ? str(value.id) : null;
  if (!isRecord(value) || !id) return null;
  const verifications = isRecord(value.verifications) ? value.verifications : {};
  return {
    id,
    status: str(value.status),
    missingFields: Array.isArray(value.missing_fields)
      ? value.missing_fields.filter((field): field is string => typeof field === "string")
      : [],
    externalAccountVerification: parseVerification(verifications.external_account),
    createdSessionId: str(value.created_session_id),
  };
}

function parseSession(value: unknown): ClerkSessionSummary | null {
  const id = isRecord(value) ? str(value.id) : null;
  if (!isRecord(value) || !id) return null;
  const user = isRecord(value.user) ? value.user : {};
  const primaryId = str(user.primary_email_address_id);
  const emails = Array.isArray(user.email_addresses) ? user.email_addresses.filter(isRecord) : [];
  const primary = emails.find((email) => email.id === primaryId) ?? emails[0];
  const name = [str(user.first_name), str(user.last_name)].filter(Boolean).join(" ");
  return {
    id,
    status: str(value.status),
    email: str(primary?.email_address),
    name: name || null,
    imageUrl: str(user.image_url),
  };
}

export function parseClerkClient(value: unknown): ClerkClientState {
  const client = isRecord(value) ? value : {};
  const sessions = Array.isArray(client.sessions) ? client.sessions : [];
  return {
    sessions: sessions.map(parseSession).filter((session): session is ClerkSessionSummary => session !== null),
    lastActiveSessionId: str(client.last_active_session_id),
    signIn: parseSignIn(client.sign_in),
    signUp: parseSignUp(client.sign_up),
    captchaBypass: client.captcha_bypass === true,
  };
}

/** The active session on this browser, if Clerk has one. */
export function activeClerkSession(client: ClerkClientState): ClerkSessionSummary | null {
  const active = client.sessions.filter((session) => session.status === "active" || session.status === null);
  return active.find((session) => session.id === client.lastActiveSessionId) ?? active[0] ?? null;
}

function parseEnvironment(value: unknown): ClerkEnvironment {
  const env = isRecord(value) ? value : {};
  const userSettings = isRecord(env.user_settings) ? env.user_settings : {};
  const social = isRecord(userSettings.social) ? userSettings.social : {};
  const attributes = isRecord(userSettings.attributes) ? userSettings.attributes : {};
  const email = isRecord(attributes.email_address) ? attributes.email_address : {};
  const firstFactors = Array.isArray(email.first_factors) ? email.first_factors : [];
  const signUp = isRecord(userSettings.sign_up) ? userSettings.sign_up : {};
  const display = isRecord(env.display_config) ? env.display_config : {};
  return {
    socialStrategies: Object.entries(social)
      .filter(([, provider]) => isRecord(provider) && provider.enabled === true && provider.authenticatable !== false)
      .map(([strategy]) => strategy),
    emailCodeEnabled: email.enabled === true && firstFactors.includes("email_code"),
    signUpCaptchaEnabled: signUp.captcha_enabled === true,
    captchaProvider: str(display.captcha_provider),
    captchaSiteKey: str(display.captcha_public_key),
    captchaInvisibleSiteKey: str(display.captcha_public_key_invisible),
    captchaWidgetType: str(display.captcha_widget_type) ?? str(signUp.captcha_widget_type),
    captchaOauthBypass: Array.isArray(display.captcha_oauth_bypass)
      ? display.captcha_oauth_bypass.filter((strategy): strategy is string => typeof strategy === "string")
      : [],
  };
}

/** A development instance (`*.clerk.accounts.dev`) has no cross-site cookies. */
export function isClerkDevelopmentHost(fapiBase: string): boolean {
  try {
    return new URL(fapiBase).hostname.endsWith(".accounts.dev");
  } catch {
    return false;
  }
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

export type ClerkFrontendApiOptions = {
  /** The FAPI origin, which is also the OAuth issuer (`https://clerk.ade-app.dev`). */
  fapiBase: string;
  fetchImpl?: typeof fetch;
  storage?: Storage | null;
};

export class ClerkFrontendApi {
  private readonly fapiBase: string;
  private readonly development: boolean;
  private readonly options: ClerkFrontendApiOptions;
  private devBrowserPromise: Promise<string | null> | null = null;

  constructor(options: ClerkFrontendApiOptions) {
    this.options = options;
    this.fapiBase = options.fapiBase.replace(/\/+$/, "");
    this.development = isClerkDevelopmentHost(this.fapiBase);
  }

  private get storage(): Storage | null {
    if (this.options.storage !== undefined) return this.options.storage;
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  /**
   * A development instance hands the dev-browser id back on the URL after an
   * OAuth round trip; take it into storage and off the address bar.
   */
  adoptDevBrowserFromUrl(location: Pick<Location, "href">, replace: (url: string) => void): void {
    if (!this.development) return;
    const url = new URL(location.href);
    const token = url.searchParams.get(DEV_BROWSER_PARAM);
    if (!token) return;
    this.storage?.setItem(DEV_BROWSER_KEY, token);
    url.searchParams.delete(DEV_BROWSER_PARAM);
    replace(`${url.pathname}${url.search}${url.hash}`);
  }

  /**
   * A page navigation to this Clerk instance (the OAuth authorize step) must
   * carry the dev-browser id on a development instance, which has no cookies
   * across sites (clerk-js `buildUrlWithAuth`). Production rides on the
   * `__client` cookie, so the URL is left as it is.
   */
  decorateNavigationUrl(rawUrl: string): string {
    if (!this.development) return rawUrl;
    const devBrowser = this.storage?.getItem(DEV_BROWSER_KEY) ?? null;
    if (!devBrowser) return rawUrl;
    try {
      const url = new URL(rawUrl);
      if (url.origin !== new URL(this.fapiBase).origin) return rawUrl;
      url.searchParams.set(DEV_BROWSER_PARAM, devBrowser);
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  private async devBrowser(): Promise<string | null> {
    if (!this.development) return null;
    const stored = this.storage?.getItem(DEV_BROWSER_KEY) ?? null;
    if (stored) return stored;
    if (!this.devBrowserPromise) {
      this.devBrowserPromise = (async () => {
        const response = await this.fetchJson("POST", "/v1/dev_browser", undefined, null);
        const id = isRecord(response) ? str(response.id) ?? str(response.token) : null;
        if (id) this.storage?.setItem(DEV_BROWSER_KEY, id);
        return id;
      })().finally(() => {
        this.devBrowserPromise = null;
      });
    }
    return await this.devBrowserPromise;
  }

  private async fetchJson(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: Record<string, string | boolean | undefined> | undefined,
    devBrowser: string | null,
  ): Promise<unknown> {
    const url = new URL(`${this.fapiBase}${path}`);
    url.searchParams.set("__clerk_api_version", CLERK_API_VERSION);
    if (method !== "GET" && method !== "POST") url.searchParams.set("_method", method);
    if (devBrowser) url.searchParams.set(DEV_BROWSER_PARAM, devBrowser);
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body ?? {})) {
      if (value !== undefined) form.set(key, String(value));
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(url.toString(), {
      method: method === "GET" ? "GET" : "POST",
      credentials: "include",
      ...(method === "GET" ? {} : {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const errors = isRecord(payload) && Array.isArray(payload.errors) ? payload.errors.filter(isRecord) : [];
      const first = errors[0] ?? {};
      throw new ClerkApiError({
        code: str(first.code) ?? `http_${response.status}`,
        message: str(first.long_message) ?? str(first.message) ?? "Sign-in failed. Try again.",
        status: response.status,
        meta: isRecord(first.meta) ? first.meta : {},
      });
    }
    return payload;
  }

  private async call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, string | boolean | undefined>,
  ): Promise<{ response: unknown; client: ClerkClientState | null }> {
    const payload = await this.fetchJson(method, path, body, await this.devBrowser());
    const wrapped = isRecord(payload) ? payload : {};
    const response = "response" in wrapped ? wrapped.response : payload;
    // `client` rides along on most calls; `/v1/client` returns it as the response.
    const rawClient = isRecord(wrapped.client)
      ? wrapped.client
      : isRecord(response) && response.object === "client" ? response : null;
    return { response, client: rawClient ? parseClerkClient(rawClient) : null };
  }

  async environment(): Promise<ClerkEnvironment> {
    const { response } = await this.call("GET", "/v1/environment");
    return parseEnvironment(response);
  }

  async client(): Promise<ClerkClientState> {
    const { client } = await this.call("GET", "/v1/client");
    return client ?? parseClerkClient(null);
  }

  /** Ends every session this browser holds with Clerk (the sign-out half of "Use another account"). */
  async removeSessions(): Promise<ClerkClientState> {
    const { client } = await this.call("DELETE", "/v1/client/sessions");
    return client ?? parseClerkClient(null);
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.call("POST", `/v1/client/sessions/${encodeURIComponent(sessionId)}/touch`);
  }

  private signInFrom(result: { response: unknown }): ClerkSignIn {
    const signIn = parseSignIn(result.response);
    if (!signIn) throw new ClerkApiError({ code: "unexpected_response", message: "Sign-in failed. Try again.", status: 200 });
    return signIn;
  }

  private signUpFrom(result: { response: unknown }): ClerkSignUp {
    const signUp = parseSignUp(result.response);
    if (!signUp) throw new ClerkApiError({ code: "unexpected_response", message: "Sign-up failed. Try again.", status: 200 });
    return signUp;
  }

  async createSignIn(params: Record<string, string | boolean | undefined>): Promise<ClerkSignIn> {
    return this.signInFrom(await this.call("POST", "/v1/client/sign_ins", params));
  }

  async prepareSignInEmailCode(signInId: string, emailAddressId: string): Promise<ClerkSignIn> {
    return this.signInFrom(await this.call("POST", `/v1/client/sign_ins/${encodeURIComponent(signInId)}/prepare_first_factor`, {
      strategy: "email_code",
      email_address_id: emailAddressId,
    }));
  }

  async attemptSignInEmailCode(signInId: string, code: string): Promise<ClerkSignIn> {
    return this.signInFrom(await this.call("POST", `/v1/client/sign_ins/${encodeURIComponent(signInId)}/attempt_first_factor`, {
      strategy: "email_code",
      code,
    }));
  }

  async createSignUp(params: Record<string, string | boolean | undefined>): Promise<ClerkSignUp> {
    return this.signUpFrom(await this.call("POST", "/v1/client/sign_ups", params));
  }

  async prepareSignUpEmailCode(signUpId: string): Promise<ClerkSignUp> {
    return this.signUpFrom(await this.call("POST", `/v1/client/sign_ups/${encodeURIComponent(signUpId)}/prepare_verification`, {
      strategy: "email_code",
    }));
  }

  async attemptSignUpEmailCode(signUpId: string, code: string): Promise<ClerkSignUp> {
    return this.signUpFrom(await this.call("POST", `/v1/client/sign_ups/${encodeURIComponent(signUpId)}/attempt_verification`, {
      strategy: "email_code",
      code,
    }));
  }
}
