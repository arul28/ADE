/**
 * The OpenAI key ADE uses for CTO voice calls: the store, the field, and every
 * sentence said about it.
 *
 * Two peer surfaces ask for this key — the settings card and the sheet the
 * voice feature mounts on first use — and neither may own the other. They used
 * to: the card imported the hook, the field and the copy FROM the sheet, so a
 * change to the modal could move the card, and the two spoke about the same
 * environment variable in two different sentences.
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
import type { MachineApiKeyStatus } from "../../../shared/types/config";
import { openLinkFromUi } from "../../lib/openExternal";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";

/** The provider id the voice key is stored under — the same `OPENAI_API_KEY` secret. */
export const OPENAI_VOICE_PROVIDER = "openai";

/** Fallback for a status read that could not name the variable itself. */
export const OPENAI_ENV_VAR = "OPENAI_API_KEY";

export const OPENAI_KEY_URL = "https://platform.openai.com/api-keys";

/**
 * The price, stated before the key is asked for rather than discovered on a
 * bill. The second sentence exists because the obvious worry — "am I about to
 * move my whole CTO onto my own OpenAI spend?" — is the one that stops people
 * pasting a key at all. Two short sentences, because one long one with a dash
 * in the middle is the sentence people skip.
 */
const OPENAI_VOICE_COST_LINE =
  "Calls cost about $0.05 a minute on this key. "
  + "The CTO's thinking stays on your current plan.";

/** The env var, said in words rather than printed as a bare mono label. */
export function openAiEnvHint(envVar: string | null | undefined): string {
  return `Also read from ${envVar ?? OPENAI_ENV_VAR}.`;
}

/** Read only by `OpenAiKeyCostLine` below, which both surfaces render. */
const OPENAI_KEY_LINK_LABEL = "Get a key at platform.openai.com";

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
    const read = bridge?.getMachineApiKeyStatus;
    if (!read) {
      setLoading(false);
      setError(MISSING_BRIDGE_MESSAGE);
      return;
    }
    // Two guards, because they answer different questions. `mounted` is one
    // ref for the component's whole life and cannot tell one run of this effect
    // from the next: change `provider` while a read is in flight and the old
    // provider's answer still arrives, still passes `mounted`, and writes
    // itself into the new provider's status. `stale` is per run.
    let stale = false;
    void read(provider)
      .then((next) => {
        if (stale) return;
        setStatus(next);
        setError(null);
      })
      .catch(() => {
        if (stale) return;
        setError("ADE couldn't read the stored key.");
      })
      .finally(() => {
        if (stale) return;
        setLoading(false);
      });
    return () => { stale = true; };
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
        // Kept whole: wrapping split it into "Get a key at" and
        // "platform.openai.com" on two lines, which reads as two things.
        style={{ color: COLORS.accent, textDecoration: "none", cursor: "pointer", whiteSpace: "nowrap" }}
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
      <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
        {openAiEnvHint(envVar)}
      </div>
    </div>
  );
}

/**
 * What to say when the machine's own `OPENAI_API_KEY` is already set.
 *
 * Both surfaces asked this question and answered it differently — "overrides
 * it for ADE" on one, "replaces it for ADE" on the other, about the same key.
 */
export function openAiEnvShadowNote(envVar: string | null | undefined): string {
  return `This computer already sets ${envVar ?? OPENAI_ENV_VAR}. Save a key here and ADE uses that one instead.`;
}
