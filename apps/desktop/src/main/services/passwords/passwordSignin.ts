import type { BuiltInBrowserAgentActionResult } from "../../../shared/types/builtInBrowser";
import { captureError } from "../../../shared/sentry/capture";
import type { PasswordLoginRequestResult } from "../../../shared/passwordLoginRequest";

export type BrowserSignin = {
  signin(args: Record<string, unknown>): Promise<BuiltInBrowserAgentActionResult>;
};

export type BrowserSignup = {
  signup(args: Record<string, unknown>): Promise<BuiltInBrowserAgentActionResult>;
};

/** One fill, for Activity and the chat's quiet line (never a value). `by` is stamped by the RPC server. */
export type PasswordAgentUse = { itemId: string; site: string; username: string | null; chatSessionId: string | null; by: "agent" | "person" };

/** Who called, as the RPC server stamped it (`calledBy`); anything else counts as an agent. */
function calledBy(args: Record<string, unknown>): "agent" | "person" {
  return args.calledBy === "person" ? "person" : "agent";
}

/**
 * `passwords.signin` — what `ade browser signin` runs.
 *
 * 1. Fill a saved login into the tab's page (`built_in_browser.signin`, on the
 *    desktop that shows the tab).
 * 2. No saved login for the page: ask the person in the agent's own chat with
 *    the secure sign-in card. A saved answer is pushed to the account, then
 *    the fill runs again (the desktop pulls it first).
 * 3. The person chose to type it into the page: the result says so, and the
 *    agent waits for them (`ade browser handoff`).
 *
 * The result never carries a value: only the site, the account and which
 * fields were filled.
 */
export async function signInWithPasswords(
  deps: {
    browser: BrowserSignin;
    passwords: { sync(): Promise<void> };
    /** Activity and the chat's quiet line, after a fill. Failures never fail the sign-in. */
    noteUse?: (use: PasswordAgentUse) => Promise<void>;
    requestLogin: ((args: Record<string, unknown>) => Promise<PasswordLoginRequestResult>) | null;
  },
  args: Record<string, unknown>,
): Promise<BuiltInBrowserAgentActionResult> {
  // The browser call carries the caller's stamped identity (its chat and
  // lane own the tab); `reason` and `timeoutMs` are only for the card.
  const { reason, timeoutMs, calledBy: _stamped, ...callerArgs } = args;
  // An agent's sign-in fills only on a login's exact saved address, whatever
  // the caller asked: never on another subdomain of the site.
  const browserArgs = { ...callerArgs, exactOrigin: true };
  const chatSessionId = args.chatSessionId;
  const chat = typeof chatSessionId === "string" && chatSessionId ? chatSessionId : null;
  const noted = async <T extends BuiltInBrowserAgentActionResult>(result: T): Promise<T> => {
    const done = result.signin;
    if (done && !done.needsLogin && done.itemId && done.filled.length) {
      await deps.noteUse?.({ itemId: done.itemId, site: done.site, username: done.username, chatSessionId: chat, by: calledBy(args) })
        .catch((error: unknown) => captureError(error, { tags: { area: "passwords", op: "signin_activity" } }));
    }
    return result;
  };
  const first = await deps.browser.signin(browserArgs);
  if (!first.signin?.needsLogin) return await noted(first);
  const site = first.signin.site;
  const pageUrl = first.signin.pageUrl ?? "";
  if (!deps.requestLogin || typeof chatSessionId !== "string" || !chatSessionId) {
    throw new Error(`No saved login for ${site}. Ask the person to add one in Settings › Passwords, or hand the page to them with \`ade browser handoff\`.`);
  }
  const answer = await deps.requestLogin({ chatSessionId, pageUrl, reason, timeoutMs });
  if (answer.saved) {
    await deps.passwords.sync();
    const filled = await deps.browser.signin({ ...browserArgs, itemId: answer.itemId });
    if (filled.signin?.needsLogin) {
      throw new Error(`The login for ${site} was saved, but this computer could not open it yet. Run \`ade browser signin\` again in a moment.`);
    }
    return await noted(filled);
  }
  if ("signInYourself" in answer) {
    return {
      ...first,
      signin: { ...first.signin, needsLogin: false, signInYourself: true },
    };
  }
  throw new Error(`The person declined to sign in to ${site}.`);
}

/**
 * `passwords.signup` — what `ade browser signup` runs: the desktop that shows
 * the tab makes a password, types it into the sign-up form, and saves the
 * login once the form holds all of it (`built_in_browser.signup`). The result
 * names the site and account.
 */
export async function signUpWithPasswords(
  deps: {
    browser: BrowserSignup;
    /** Activity and the chat's quiet line. Failures never fail the sign-up. */
    noteUse?: (use: PasswordAgentUse) => Promise<void>;
  },
  args: Record<string, unknown>,
): Promise<BuiltInBrowserAgentActionResult> {
  const chatSessionId = typeof args.chatSessionId === "string" && args.chatSessionId ? args.chatSessionId : null;
  const { calledBy: _stamped, ...browserArgs } = args;
  const result = await deps.browser.signup(browserArgs);
  const made = result.signin;
  if (made?.itemId) {
    await deps.noteUse?.({ itemId: made.itemId, site: made.site, username: made.username, chatSessionId, by: calledBy(args) })
      .catch((error: unknown) => captureError(error, { tags: { area: "passwords", op: "signup_activity" } }));
  }
  return result;
}
