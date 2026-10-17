/** Feedback to Meta. The note goes to Meta, not to ADE. */
import React, { useCallback, useState } from "react";
import { SANS_FONT, outlineButton, primaryButton } from "../../../../lanes/laneDesignTokens";
import { showToast } from "../../../../app/toast/toastStore";
import { useSettingsAction } from "../../../useSettingsAction";
import type {
  MuseFeedbackClassification,
  MuseFeedbackResult,
} from "../../../../../../shared/museSettings";
import type { MuseRun } from "./museSettingsShared";
import { ErrorNotice, FIELD, SMALL_BUTTON, SectionHeader, TEXT_MUTED, isOneOf } from "./museSettingsShared";

const CLASSIFICATIONS: Record<MuseFeedbackClassification, string> = {
  bug: "Bug",
  badResult: "Bad result",
  goodResult: "Good result",
  other: "Other",
};
const SENT_OUTCOMES: ReadonlySet<string> = new Set<string>(["uploaded", "recorded", "acceptedWithoutReceipt"]);

const FEEDBACK_OUTCOME: Record<string, string> = {
  uploaded: "Sent to Meta. Thanks.",
  recorded: "Recorded by Meta. Thanks.",
  acceptedWithoutReceipt: "Sent; Meta did not confirm receipt.",
  noCredential: "Not sent: Muse needs a Meta sign-in or API key to send feedback. It was saved locally.",
  authRejected: "Not sent: Meta rejected this machine's sign-in. It was saved locally.",
  rateLimited: "Not sent: too many reports right now. Try again later.",
  disabled: "Feedback is turned off for this Muse account. It was saved locally.",
  dark: "Feedback upload is off in this Muse build. It was saved locally.",
  failed: "Not sent. It was saved locally.",
};

const CLASSIFICATION_IDS = Object.keys(CLASSIFICATIONS) as MuseFeedbackClassification[];
const isFeedbackClassification = isOneOf<MuseFeedbackClassification>(CLASSIFICATION_IDS);

function feedbackLine(result: MuseFeedbackResult): string {
  const line = FEEDBACK_OUTCOME[result.outcome] ?? `Muse answered: ${result.outcome}.`;
  return result.cause ? `${line} ${result.cause}` : line;
}

export function FeedbackSection({ run }: { run: MuseRun }) {
  const [open, setOpen] = useState(false);
  const [classification, setClassification] = useState<MuseFeedbackClassification>("bug");
  const [note, setNote] = useState("");
  const [withFiles, setWithFiles] = useState(false);
  const [result, setResult] = useState<MuseFeedbackResult | null>(null);
  const action = useSettingsAction();
  const sending = action.busy === "feedback";

  const submit = useCallback(async () => {
    setResult(null);
    const next = await action.run("feedback", () => run({ kind: "feedback", classification, note: note.trim(), withFiles }));
    if (!next) return;
    if (SENT_OUTCOMES.has(next.outcome)) {
      setNote("");
      setOpen(false);
      showToast({ tone: "success", title: feedbackLine(next) });
    } else {
      setResult(next);
    }
  }, [action.run, classification, note, run, withFiles]);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHeader title="Feedback" />
      {open ? (
        <>
          <select
            aria-label="Feedback type"
            value={classification}
            onChange={(event) => {
              const next = event.target.value;
              if (isFeedbackClassification(next)) setClassification(next);
            }}
            style={{ ...FIELD, fontFamily: SANS_FONT, alignSelf: "flex-start" }}
          >
            {CLASSIFICATION_IDS.map((id) => (
              <option key={id} value={id}>{CLASSIFICATIONS[id]}</option>
            ))}
          </select>
          <textarea
            aria-label="Feedback for Meta"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={4}
            placeholder="What happened? This goes to Meta, not to ADE."
            style={{ ...FIELD, fontFamily: SANS_FONT, resize: "vertical" }}
          />
          <label style={{ ...TEXT_MUTED, display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={withFiles} onChange={(event) => setWithFiles(event.target.checked)} />
            Include Muse's local logs
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              style={primaryButton({ height: 26, padding: "0 10px", fontSize: 12 })}
              disabled={sending || !note.trim()}
              onClick={() => void submit()}
            >
              {sending ? "Sending…" : "Send to Meta"}
            </button>
            <button type="button" style={SMALL_BUTTON} disabled={sending} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <button type="button" style={{ ...outlineButton({ height: 26, padding: "0 10px", fontSize: 12 }), alignSelf: "flex-start" }} onClick={() => setOpen(true)}>
          Send feedback to Meta
        </button>
      )}
      <ErrorNotice id="muse-feedback-result" message={result ? feedbackLine(result) : null} />
      <ErrorNotice id="muse-feedback-error" message={action.error} />
    </section>
  );
}
