/**
 * Settings → Agents & Models → Connections → "OpenAI API key".
 *
 * The lifecycle is Cursor's, deliberately: add → verify by storing → connected
 * → replace / delete, with the same two rules that make it safe. The secret is
 * never re-displayed once saved, and Replace/Delete are offered ONLY for a key
 * ADE itself stored — an `OPENAI_API_KEY` inherited from the machine's
 * environment is shown read-only, because deleting it here would delete
 * nothing and leave the user believing otherwise.
 *
 * Unlike every other key on this page, this one follows the MACHINE. It lives
 * in `~/.ade/secrets`, not `<project>/.ade/secrets`, so it survives switching
 * projects — hence the machine scope chip on the card.
 */
import React, { useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { SettingsCard } from "./primitives";
import { SourceBadge } from "./providers/providerUi";
import {
  OPENAI_ENV_VAR,
  OpenAiKeyCostLine,
  OpenAiKeyField,
  openAiEnvHint,
  useMachineOpenAiKey,
  openAiEnvShadowNote,
} from "./openAiKey";

/** Must match the `agents.openai-key` entry's anchor in `settingsManifest.ts`. */
export const OPENAI_KEY_ANCHOR = "openai-api-key";

export function OpenAiKeySection() {
  const { status, loading, supported, error, save, remove } = useMachineOpenAiKey();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const source = status?.source ?? null;
  const envVar = status?.envVar ?? OPENAI_ENV_VAR;
  const replaceable = source === "store";

  const submit = async () => {
    const ok = await save(draft);
    if (!ok) return;
    // Dropped before the field can render again. Nothing keeps a copy.
    setDraft("");
    setEditing(false);
  };

  const cancel = () => {
    setDraft("");
    setEditing(false);
  };

  return (
    <SettingsCard
      anchor={OPENAI_KEY_ANCHOR}
      title="OpenAI API key"

      description={<OpenAiKeyCostLine compact />}
      stacked
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        {/* A field label, not the raw variable name: "OPENAI_API_KEY" in
            monospace read as a value the user was supposed to recognise. */}
        <div style={{ fontSize: 11.5, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>Key</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: 10,
            alignItems: "center",
          }}
        >
          <div style={{ minWidth: 0 }}>
            {editing ? (
              <OpenAiKeyField
                autoFocus
                value={draft}
                onChange={setDraft}
                disabled={loading || !supported}
                envVar={null}
                onSubmit={() => void submit()}
              />
            ) : source ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <SourceBadge source={source} />
                {source === "store" ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      color: COLORS.success,
                      fontSize: 10,
                      fontFamily: SANS_FONT,
                    }}
                  >
                    <CheckCircle size={12} weight="fill" />
                    Connected
                  </span>
                ) : (
                  <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
                    Read from this computer's environment
                  </span>
                )}
              </div>
            ) : (
              <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>
                {loading ? "Checking…" : "No key saved yet."}
              </span>
            )}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "flex-end",
              flexWrap: "wrap",
            }}
          >
            {editing ? (
              <>
                <button
                  type="button"
                  aria-label="Save OpenAI API key"
                  style={outlineButton({ height: 28 })}
                  disabled={loading || !supported || !draft.trim()}
                  onClick={() => void submit()}
                >
                  {loading ? "Saving…" : "Save"}
                </button>
                <button type="button" style={outlineButton({ height: 28 })} disabled={loading} onClick={cancel}>
                  Cancel
                </button>
              </>
            ) : replaceable ? (
              <>
                <button
                  type="button"
                  aria-label="Replace OpenAI API key"
                  style={outlineButton({ height: 28 })}
                  disabled={loading || !supported}
                  onClick={() => setEditing(true)}
                >
                  Replace
                </button>
                <button
                  type="button"
                  aria-label="Delete OpenAI API key"
                  style={outlineButton({ height: 28 })}
                  disabled={loading || !supported}
                  onClick={() => void remove()}
                >
                  Delete
                </button>
              </>
            ) : (
              <button
                type="button"
                aria-label="Add OpenAI API key"
                style={outlineButton({ height: 28 })}
                disabled={!supported}
                onClick={() => setEditing(true)}
              >
                Add key
              </button>
            )}
          </div>
        </div>
        {/* The variable, said in a sentence. While editing, the field prints
            its own hint, so this one stands down rather than say it twice. */}
        {!editing && source !== "env" ? (
          <div style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textMuted }}>
            {openAiEnvHint(envVar)}
          </div>
        ) : null}
        {/* An env-sourced key is real and ADE will use it; what it cannot do is
            edit it from here, so the card says where to go instead of offering
            a Delete that would do nothing. */}
        {source === "env" && !editing ? (
          <div style={{ fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.55, color: COLORS.textMuted }}>
            {openAiEnvShadowNote(envVar)}
          </div>
        ) : null}
        {error ? (
          <div role="alert" style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.danger }}>
            {error}
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}
