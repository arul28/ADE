import {
  PASSWORD_LOGIN_CHOICE_QUESTION_ID,
  PASSWORD_LOGIN_PASSWORD_QUESTION_ID,
  PASSWORD_LOGIN_REASON_MAX_CHARS,
  PASSWORD_LOGIN_REQUEST_METADATA_KEY,
  PASSWORD_LOGIN_USERNAME_QUESTION_ID,
  PASSWORD_LOGIN_WHERE_IT_GOES,
  type PasswordLoginRequestCard,
  type PasswordLoginRequestResult,
} from "../../../shared/passwordLoginRequest";
import { cardTimeoutMs, cardWasDeclined, joinInFlight, readCardArgs, type CardRequestChatInput } from "../chat/chatCardRequest";

export type PasswordLoginRequestDeps = {
  requestChatInput: CardRequestChatInput;
  passwords: {
    /** The page's site and exact origin, or null when Passwords won't fill it (not https). */
    siteForPage(pageUrl: string): { site: string; origin: string } | null;
    saveLogin(input: { origins: string[]; username: string; password: string }): Promise<{ id: string }>;
  };
};

/** One card per chat and site: an agent that runs `signin` again joins it. */
const inFlight = new Map<string, Promise<PasswordLoginRequestResult>>();

/**
 * `passwords.requestLogin` — ask the person in this chat for a login to the
 * page's site, and save it to Passwords.
 *
 * Blocks until the person answers, declines, or the wait runs out. The
 * username and password are `isSecret` answers: they reach this function in
 * memory, go straight to `saveLogin`, and are dropped. The result says only
 * what happened.
 */
export async function requestPasswordLoginFromUser(
  deps: PasswordLoginRequestDeps,
  rawArgs: unknown,
): Promise<PasswordLoginRequestResult> {
  const args = readCardArgs(rawArgs);
  const chatSessionId = typeof args.chatSessionId === "string" ? args.chatSessionId.trim() : "";
  if (!chatSessionId) {
    throw new Error("Asking for a login needs a chat to ask in. Run `ade browser signin` from inside an ADE chat.");
  }
  const pageUrl = typeof args.pageUrl === "string" ? args.pageUrl.trim() : "";
  const target = deps.passwords.siteForPage(pageUrl);
  if (!target) throw new Error("Passwords fills logins only on https pages (or localhost).");
  return await joinInFlight(inFlight, `${chatSessionId}\u0000${target.origin}`, () => askLogin(deps, args, chatSessionId, target));
}

async function askLogin(
  deps: PasswordLoginRequestDeps,
  args: Record<string, unknown>,
  chatSessionId: string,
  target: { site: string; origin: string },
): Promise<PasswordLoginRequestResult> {
  const { site, origin } = target;
  const reason = (typeof args.reason === "string" ? args.reason.trim() : "").slice(0, PASSWORD_LOGIN_REASON_MAX_CHARS)
    || `Sign in to ${site} to continue.`;
  const card: PasswordLoginRequestCard = { site, origin, reason };

  let savedId: string | null = null;
  let choseSelf = false;
  // The save runs while the answer is accepted, before the card resolves: a
  // failed save keeps the card open with the error rather than a false receipt.
  const beforeAccept = async (answers: Record<string, string[]>): Promise<void> => {
    if (answers[PASSWORD_LOGIN_CHOICE_QUESTION_ID]?.[0] === "self") {
      choseSelf = true;
      return;
    }
    const username = (answers[PASSWORD_LOGIN_USERNAME_QUESTION_ID]?.[0] ?? "").trim();
    const password = answers[PASSWORD_LOGIN_PASSWORD_QUESTION_ID]?.[0] ?? "";
    if (!password) throw new Error("Enter the password, or choose to type it into the page yourself.");
    try {
      savedId = (await deps.passwords.saveLogin({ origins: [origin], username, password })).id;
    } catch (error) {
      // The service's own messages never carry a value.
      const detail = error instanceof Error ? error.message : "unknown error";
      throw new Error(`ADE could not save the login for ${site}: ${detail}`);
    }
  };

  const response = await deps.requestChatInput({
    beforeAccept,
    chatSessionId,
    title: `Sign in to ${site}`,
    body: `${reason}\n\n${PASSWORD_LOGIN_WHERE_IT_GOES(site)}`,
    timeoutMs: cardTimeoutMs(args),
    allowsFreeform: true,
    eventDescription: `Sign-in needed: ${site}`,
    providerMetadata: { [PASSWORD_LOGIN_REQUEST_METADATA_KEY]: card },
    questions: [
      {
        id: PASSWORD_LOGIN_CHOICE_QUESTION_ID,
        header: site,
        question: `How do you want to sign in to ${site}?`,
        allowsFreeform: false,
        options: [
          { label: "Save & sign in", value: "save", description: PASSWORD_LOGIN_WHERE_IT_GOES(site), recommended: true },
          { label: "Enter it myself in the browser", value: "self", description: "Type it into the page yourself; ADE offers to save it after." },
        ],
      },
      { id: PASSWORD_LOGIN_USERNAME_QUESTION_ID, header: site, question: "Username or email", allowsFreeform: true, isSecret: true },
      { id: PASSWORD_LOGIN_PASSWORD_QUESTION_ID, header: site, question: "Password", allowsFreeform: true, isSecret: true },
    ],
  });

  if (response.timedOut) {
    throw new Error(`Nobody answered the sign-in request for ${site} in time. Ask again when the person is around.`);
  }
  if (cardWasDeclined(response)) return { site, saved: false, declined: true };
  const itemId = savedId as string | null;
  if (itemId) return { site, saved: true, itemId };
  if (choseSelf) return { site, saved: false, signInYourself: true };
  return { site, saved: false, declined: true };
}
