/**
 * Dev only: the test sign-in of `vite.webclient.config.ts` (`devTestSession`).
 * When the dev server was started with `ADE_DEV_TEST_SESSION_FILE`, it gives
 * a fresh session token of a test account at `/__ade_dev/session-token`, and
 * the web client signs in with it. A production build has no such route, and
 * `import.meta.env.DEV` is false there, so this code is removed from it.
 */

const DEV_SESSION_TOKEN_PATH = "/__ade_dev/session-token";

/** A session token of the dev test account, or null when the dev server has none (or this is not a dev build). */
export async function fetchDevTestSessionToken(): Promise<string | null> {
  if (!import.meta.env.DEV) return null;
  try {
    const response = await fetch(DEV_SESSION_TOKEN_PATH, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as { token?: unknown } | null;
    return typeof body?.token === "string" && body.token.split(".").length === 3 ? body.token : null;
  } catch {
    return null;
  }
}
