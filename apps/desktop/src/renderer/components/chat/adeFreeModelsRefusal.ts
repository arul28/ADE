import type { ChatErrorPresentation } from "../../../shared/chatErrorPresentation";

/**
 * The two ADE Free Models refusals a chat can't fix by retrying alone
 * (`CloudFreeModelsErrorCode`): the account server's OpenAI-shaped error
 * reaches the transcript through OpenCode as its message (and, where OpenCode
 * keeps it, its code), so both are read. Any machine, any chat: the words are
 * the server's.
 * - `locked`: the GitHub rule holds them; a card (no charge) unlocks them.
 * - `no_cards`: used a long time with no card on screen; a card showing
 *   lets them run again.
 */
export type AdeFreeModelsRefusal = "locked" | "no_cards";

const LOCKED = [/free_models_locked/, /to unlock ADE Free Models/i];
const NO_CARDS = [/free_models_no_cards/, /ADE Free Models are paid for by the sponsored cards/i];

export function adeFreeModelsRefusalOf(...texts: Array<string | null | undefined>): AdeFreeModelsRefusal | null {
  const text = texts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
  if (!text || !/free.?models/i.test(text)) return null;
  if (LOCKED.some((pattern) => pattern.test(text))) return "locked";
  if (NO_CARDS.some((pattern) => pattern.test(text))) return "no_cards";
  return null;
}

/** The transcript's line for each refusal; the server's own words stay under Details. */
export function adeFreeModelsRefusalPresentation(refusal: AdeFreeModelsRefusal, technicalDetail: string): ChatErrorPresentation {
  return refusal === "locked"
    ? {
        title: "ADE Free Models are locked",
        body: "Add a card (no charge) to unlock them. This chat is kept; retry once they're unlocked.",
        technicalDetail,
      }
    : {
        title: "ADE Free Models are paused",
        body: "Cards pay for ADE Free Models. Keep this chat on screen so a card can show, then retry.",
        technicalDetail,
      };
}
