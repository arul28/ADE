/**
 * The key sheet: the whole ask in one block, for a surface that has to collect
 * a key before it can do anything else (the Talk button, on first use).
 *
 * The store, the field and the copy live in `openAiKey` next door, shared with
 * the settings card as peers rather than one importing from the other.
 *
 * The secret travels one way. It is typed into a `type="password"` field, sent
 * on save, and dropped from React state the moment the save succeeds — it is
 * never read back, never re-rendered into the field, and never logged.
 */
import { useCallback, useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import {
  OPENAI_VOICE_PROVIDER,
  OpenAiKeyCostLine,
  OpenAiKeyField,
  openAiEnvShadowNote,
  useMachineOpenAiKey,
} from "./openAiKey";

/**
 * The whole ask, in one block another surface can drop into a modal: the cost
 * line, the field, and Save. `onSaved` fires once the key is stored — by which
 * point this component has already forgotten it.
 */
export function OpenAiKeySheet({
  onSaved,
  onCancel,
  saveLabel = "Save key",
}: {
  onSaved?: () => void;
  onCancel?: () => void;
  saveLabel?: string;
}) {
  const { status, loading, supported, error, save } = useMachineOpenAiKey(OPENAI_VOICE_PROVIDER);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);

  const submit = useCallback(async () => {
    const ok = await save(draft);
    if (!ok) return;
    // The key is gone from this component before `onSaved` can run. Nothing
    // downstream is handed it, and a re-render cannot put it back on screen.
    setDraft("");
    setSaved(true);
    onSaved?.();
  }, [draft, onSaved, save]);

  const alreadyStored = status?.source === "store";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <OpenAiKeyCostLine />
      {status?.source === "env" ? (
        <div style={{ fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.55, color: COLORS.textMuted }}>
          {openAiEnvShadowNote(status.envVar)}
        </div>
      ) : null}
      <OpenAiKeyField
        autoFocus
        value={draft}
        onChange={(next) => {
          setDraft(next);
          setSaved(false);
        }}
        disabled={loading || !supported}
        envVar={status?.envVar ?? null}
        onSubmit={() => void submit()}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          aria-label="Save OpenAI API key"
          style={outlineButton({ height: 28 })}
          disabled={loading || !supported || !draft.trim()}
          onClick={() => void submit()}
        >
          {loading ? "Saving…" : alreadyStored ? "Replace key" : saveLabel}
        </button>
        {onCancel ? (
          <button type="button" style={outlineButton({ height: 28 })} disabled={loading} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        {saved && !error ? (
          <span
            role="status"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontFamily: SANS_FONT,
              fontSize: 10,
              color: COLORS.success,
            }}
          >
            <CheckCircle size={12} weight="fill" />
            Saved
          </span>
        ) : null}
      </div>
      {error ? (
        <div role="alert" style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.danger }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
