/**
 * The OpenAI key ADE uses for CTO voice calls, and the two surfaces that ask
 * for it: the settings card next door, and this sheet — which the voice feature
 * mounts in a modal the first time someone presses talk with no key stored.
 *
 * Both go through `window.ade.ai.*MachineApiKey*`, which writes to THIS
 * MACHINE's ADE home rather than the open project. That is the whole point: a
 * user who pastes a key once is not asked again in the next repo.
 *
 * The secret travels one way. It is typed into a `type="password"` field, sent
 * on save, and dropped from React state the moment the save succeeds — it is
 * never read back, never re-rendered into the field, and never logged.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import type { MachineApiKeyStatus } from "../../../shared/types/config";
import { openLinkFromUi } from "../../lib/openExternal";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";

/** The provider id the voice key is stored under — the same `OPENAI_API_KEY` secret. */
export const OPENAI_VOICE_PROVIDER = "openai";

/** Fallback for a status read that could not name the variable itself. */
const OPENAI_ENV_VAR = "OPENAI_API_KEY";

export const OPENAI_KEY_URL = "https://platform.openai.com/api-keys";

/**
 * The price, stated before the key is asked for rather than discovered on a
 * bill. The second sentence exists because the obvious worry — "am I about to
 * move my whole CTO onto my own OpenAI spend?" — is the one that stops people
 * pasting a key at all.
 */
export const OPENAI_VOICE_COST_LINE =
  "ADE uses this key for CTO voice calls — about $0.05 a minute, billed by the second. "
  + "The CTO's own thinking stays on whatever model and plan it already runs on.";

/** Copy shared by the card and the sheet, so the two cannot drift apart. */
export const OPENAI_KEY_LINK_LABEL = "Get a key at platform.openai.com";

const MISSING_BRIDGE_MESSAGE = "This build of ADE can't reach the key store. Restart ADE and try again.";

export type MachineOpenAiKey = {
  /** Null until the first read lands. */
  status: MachineApiKeyStatus | null;
  loading: boolean;
  /** False when the preload predates these calls — the UI stays read-only. */
  supported: boolean;
  error: string | null;
  save: (key: string) => Promise<boolean>;
  remove: () => Promise<boolean>;
};

/**
 * Reads and writes the machine-scoped OpenAI key.
 *
 * Never returns, caches, or accepts the key back from the main process: `save`
 * takes one and gives nothing back but success. `status` is the only thing that
 * crosses back, and it carries a source, not a secret.
 */
export function useMachineOpenAiKey(provider: string = OPENAI_VOICE_PROVIDER): MachineOpenAiKey {
  const [status, setStatus] = useState<MachineApiKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const bridge = typeof window !== "undefined" ? window.ade?.ai : undefined;
  const supported = Boolean(bridge?.getMachineApiKeyStatus);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const read = bridge?.getMachineApiKeyStatus;
    if (!read) {
      setLoading(false);
      setError(MISSING_BRIDGE_MESSAGE);
      return;
    }
    void read(provider)
      .then((next) => {
        if (cancelled || !mounted.current) return;
        setStatus(next);
        setError(null);
      })
      .catch(() => {
        if (cancelled || !mounted.current) return;
        setError("ADE couldn't read the stored key.");
      })
      .finally(() => {
        if (cancelled || !mounted.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, provider]);

  const save = useCallback(
    async (key: string): Promise<boolean> => {
      const write = bridge?.storeMachineApiKey;
      const trimmed = key.trim();
      if (!write) {
        setError(MISSING_BRIDGE_MESSAGE);
        return false;
      }
      if (!trimmed) {
        setError("Paste a key first.");
        return false;
      }
      setLoading(true);
      try {
        const next = await write(provider, trimmed);
        if (mounted.current) {
          setStatus(next);
          setError(null);
        }
        return true;
      } catch {
        // Deliberately generic: the thrown error can quote the request, and
        // nothing that may carry the key belongs on screen or in a log.
        if (mounted.current) setError("ADE couldn't save that key.");
        return false;
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [bridge, provider],
  );

  const remove = useCallback(async (): Promise<boolean> => {
    const drop = bridge?.deleteMachineApiKey;
    if (!drop) {
      setError(MISSING_BRIDGE_MESSAGE);
      return false;
    }
    setLoading(true);
    try {
      const next = await drop(provider);
      if (mounted.current) {
        setStatus(next);
        setError(null);
      }
      return true;
    } catch {
      if (mounted.current) setError("ADE couldn't remove that key.");
      return false;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [bridge, provider]);

  return { status, loading, supported, error, save, remove };
}

/** The one line about money, and the link to go get a key. */
export function OpenAiKeyCostLine({ compact = false }: { compact?: boolean }) {
  return (
    // A `span` rather than a `div`: `SettingsCard` renders `description` inside
    // a `<p>`, and a block element in there is invalid nesting React warns about.
    <span
      style={{
        display: "block",
        fontFamily: SANS_FONT,
        fontSize: compact ? 11 : 11.5,
        lineHeight: 1.55,
        color: COLORS.textMuted,
      }}
    >
      {OPENAI_VOICE_COST_LINE}{" "}
      {/* Routed through ADE's own opener so it honours the user's
          "open links in" preference instead of escaping to the OS browser. */}
      <a
        href={OPENAI_KEY_URL}
        onClick={(event) => {
          event.preventDefault();
          openLinkFromUi(OPENAI_KEY_URL, event);
        }}
        style={{ color: COLORS.accent, textDecoration: "none", cursor: "pointer" }}
      >
        {OPENAI_KEY_LINK_LABEL}
      </a>
    </span>
  );
}

/**
 * The password field plus the environment variable it shadows.
 *
 * `value` is owned by the caller so the caller can drop it the instant a save
 * succeeds; this component keeps no copy of its own.
 */
export function OpenAiKeyField({
  value,
  onChange,
  disabled,
  envVar,
  autoFocus = false,
  onSubmit,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  envVar: string | null;
  autoFocus?: boolean;
  onSubmit?: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <input
        autoFocus={autoFocus}
        aria-label="OpenAI API key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        placeholder="sk-..."
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onSubmit) {
            event.preventDefault();
            onSubmit();
          }
        }}
        style={{
          width: "100%",
          background: COLORS.cardBg,
          border: `1px solid ${COLORS.border}`,
          padding: "8px 10px",
          fontSize: 11,
          fontFamily: MONO_FONT,
          color: COLORS.textPrimary,
          outline: "none",
        }}
      />
      <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
        {envVar ?? OPENAI_ENV_VAR}
      </div>
    </div>
  );
}

/**
 * The whole ask, in one block another surface can drop into a modal: the cost
 * line, the field, and Save. `onSaved` fires once the key is stored — by which
 * point this component has already forgotten it.
 */
export function OpenAiKeySheet({
  provider = OPENAI_VOICE_PROVIDER,
  onSaved,
  onCancel,
  saveLabel = "Save key",
}: {
  provider?: string;
  onSaved?: () => void;
  onCancel?: () => void;
  saveLabel?: string;
}) {
  const { status, loading, supported, error, save } = useMachineOpenAiKey(provider);
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
          {`${status.envVar ?? OPENAI_ENV_VAR} is already set on this machine. Saving a key here overrides it for ADE.`}
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
