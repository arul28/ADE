import { BRAND } from "../../../shared/brand";
import { memo, type CSSProperties } from "react";
import { Gift, LockSimple, PauseCircle } from "@phosphor-icons/react";
import { useCloudAccount } from "../../state/cloudAccountStore";
import { askAdeFreeModelsUnlock } from "../shared/ModelPicker/AdeFreeModelsUnlockDialog";
import "./providerSignInSlot.css";

/**
 * One calm line on the prompt box of an ADE Free Models chat when the account
 * server says they don't run normally for this account
 * (`CloudFreeModelsState`):
 * - `locked`: the GitHub rule holds them (a card removed, a check pending):
 *   "Add a card" opens the unlock sheet. The next request is refused with
 *   the same reason (`adeFreeModelsRefusal.ts`); the chat itself is kept.
 * - `throttle` `slowed` / `paused`: used a long time with no card on screen.
 *   The cards pay for these models, so keep the chat on screen. Paused reads
 *   stronger (the server refuses until a card shows).
 * Account level, so no pin: the state is the account's on every machine. The
 * strip is the sign-in strip's tab (`providerSignInSlot.css`), so the box
 * doesn't move when it comes and goes.
 */

const THROTTLE_LINE = `Ads pay for ${BRAND.NAME} Free Models. Keep this chat on screen so an ad can show.`;

type Note = {
  kind: "locked" | "checking" | "paused" | "slowed";
  long: string;
  short: string;
};

export const AdeFreeModelsComposerNote = memo(function AdeFreeModelsComposerNote({ active }: {
  /** The pane's chat runs on an ADE Free Model and is on screen. */
  active: boolean;
}) {
  const freeModels = useCloudAccount(active)?.freeModels ?? null;
  if (!active || !freeModels) return null;
  let note: Note | null = null;
  if (freeModels.locked) {
    note = freeModels.locked.reason === "checking"
      ? { kind: "checking", long: `Checking your GitHub account… ${BRAND.NAME} Free Models unlock once that's done.`, short: "Checking your GitHub account…" }
      : { kind: "locked", long: `${BRAND.NAME} Free Models are locked on this account. Add a card (no charge) to unlock them.`, short: `${BRAND.NAME} Free Models are locked.` };
  } else if (freeModels.throttle === "paused") {
    note = { kind: "paused", long: `Paused. ${THROTTLE_LINE}`, short: "Paused until an ad shows." };
  } else if (freeModels.throttle === "slowed") {
    note = { kind: "slowed", long: THROTTLE_LINE, short: "Keep this chat on screen for an ad." };
  }
  if (!note) return null;
  // Sky like the free models' badge; amber where the next request is refused.
  const strong = note.kind === "paused" || note.kind === "locked";
  const Icon = note.kind === "locked" || note.kind === "checking" ? LockSimple : note.kind === "paused" ? PauseCircle : Gift;
  return (
    <div
      className="ade-psi-strip"
      role="status"
      data-testid="ade-free-models-composer-note"
      data-kind={note.kind}
      style={{ "--psi-accent": strong ? "#f59e0b" : "#38bdf8" } as CSSProperties}
    >
      <span className="ade-psi-logo" aria-hidden>
        <Icon size={13} weight={strong ? "fill" : "duotone"} style={{ color: strong ? "var(--color-amber-400, #fbbf24)" : "var(--color-sky-300, #7dd3fc)" }} />
      </span>
      <span className="ade-psi-text ade-psi-long">
        <span className="ade-psi-lead" title={note.long}>{note.long}</span>
      </span>
      <span className="ade-psi-text ade-psi-short">
        <span className="ade-psi-lead" title={note.long}>{note.short}</span>
      </span>
      {note.kind === "locked" ? (
        <button type="button" className="kit-btn ade-psi-button" data-size="sm" onClick={() => void askAdeFreeModelsUnlock()}>
          Add a card
        </button>
      ) : null}
    </div>
  );
});
