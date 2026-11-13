import type { BuiltInBrowserAgentActionResult } from "../../../shared/types/builtInBrowser";
import type { PasswordLoginRequestResult } from "../../../shared/passwordLoginRequest";

export type BrowserSignin = {
  signin(args: Record<string, unknown>): Promise<BuiltInBrowserAgentActionResult>;
};

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
    requestLogin: ((args: Record<string, unknown>) => Promise<PasswordLoginRequestResult>) | null;
  },
  args: Record<string, unknown>,
): Promise<BuiltInBrowserAgentActionResult & { signin?: Record<string, unknown> }> {
  const { chatSessionId, reason, timeoutMs, ...browserArgs } = args;
  const first = await deps.browser.signin(browserArgs);
  if (!first.signin?.needsLogin) return first;
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
    return filled;
  }
  if ("signInYourself" in answer) {
    return {
      ...first,
      signin: { ...first.signin, needsLogin: false, signInYourself: true },
    };
  }
  throw new Error(`The person declined to sign in to ${site}.`);
}
