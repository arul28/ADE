import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle, Copy, Info, WarningCircle, X } from "@phosphor-icons/react";
import type {
  OpenCodeProviderAuthMethod,
  OpenCodeProviderAuthPrompt,
  OpenCodeOAuthStartResult,
  OpenCodeOAuthStatusEvent,
} from "../../../shared/types/config";
import { isAllowedOpenCodeOAuthUrl } from "../../../shared/opencodeOAuth";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { ProviderLogo } from "../shared/ProviderLogos";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

const CODE_PATTERN = /[A-Z0-9]{4,}-[A-Z0-9]{4,}/;

/** Pull a human-typeable device code out of the CLI instructions blob. */
function extractDeviceCode(instructions: string | undefined): string | null {
  if (!instructions) return null;
  const match = instructions.match(CODE_PATTERN);
  return match?.[0] ?? null;
}

function extractHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function promptVisible(
  prompt: OpenCodeProviderAuthPrompt,
  inputs: Record<string, string>,
): boolean {
  if (!prompt.when) return true;
  const current = inputs[prompt.when.key] ?? "";
  return prompt.when.op === "eq"
    ? current === prompt.when.value
    : current !== prompt.when.value;
}

function buildPromptDefaults(prompts: OpenCodeProviderAuthPrompt[]): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const prompt of prompts) {
    defaults[prompt.key] = prompt.type === "select" ? prompt.options?.[0]?.value ?? "" : "";
  }
  return defaults;
}

type Phase = "form" | "starting" | "waiting" | "error";

export function OAuthConnectModal({
  providerId,
  providerName,
  methods,
  onClose,
  onConnected,
}: {
  providerId: string;
  providerName: string;
  /** The provider's full auth-method list (index is meaningful to the backend). */
  methods: OpenCodeProviderAuthMethod[];
  onClose: () => void;
  onConnected: () => void;
}) {
  const oauthMethods = useMemo(
    () => methods.map((method, index) => ({ method, index })).filter((entry) => entry.method.type === "oauth"),
    [methods],
  );
  const [methodIndex, setMethodIndex] = useState(() => oauthMethods[0]?.index ?? 0);
  const method = methods[methodIndex];
  const prompts = method?.prompts ?? [];

  const [inputs, setInputs] = useState<Record<string, string>>(() => buildPromptDefaults(prompts));
  const [phase, setPhase] = useState<Phase>("form");
  const [startResult, setStartResult] = useState<OpenCodeOAuthStartResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const visiblePrompts = prompts.filter((prompt) => promptVisible(prompt, inputs));
  const deviceCode = extractDeviceCode(startResult?.instructions);
  const host = extractHost(startResult?.url);

  // Tracks whether a backend flow is in flight so unmount can cancel it —
  // in-modal close paths cancel explicitly, but a parent unmount (nav away,
  // settings close) would otherwise leave the poller running to its timeout.
  const flowActiveRef = useRef(false);
  const startPendingRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  useEffect(
    () => () => {
      cancelRequestedRef.current = true;
      if (startPendingRef.current || flowActiveRef.current) {
        void window.ade.ai.opencodeOAuthCancel({ providerId }).catch(() => undefined);
      }
    },
    [providerId],
  );

  // Subscribe to backend OAuth status pushes for this provider.
  useEffect(() => {
    const unsubscribe = window.ade.ai.onOpencodeOAuthStatus((event: OpenCodeOAuthStatusEvent) => {
      if (event.providerId !== providerId) return;
      if (event.state !== "pending") flowActiveRef.current = false;
      if (event.state === "connected") {
        onConnected();
        onClose();
      } else if (event.state === "failed" || event.state === "timeout" || event.state === "cancelled") {
        setPhase("error");
        setErrorMessage(
          event.error
            ?? (event.state === "timeout"
              ? "Timed out waiting for approval."
              : event.state === "cancelled"
                ? "Sign-in was cancelled."
                : "Sign-in failed."),
        );
      }
    });
    return () => {
      unsubscribe();
    };
  }, [providerId, onClose, onConnected]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void handleCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startFlow = async () => {
    cancelRequestedRef.current = false;
    startPendingRef.current = true;
    setPhase("starting");
    setErrorMessage(null);
    try {
      const filteredInputs: Record<string, string> = {};
      for (const prompt of visiblePrompts) {
        filteredInputs[prompt.key] = inputs[prompt.key] ?? "";
      }
      const result = await window.ade.ai.opencodeOAuthStart({
        providerId,
        methodIndex,
        inputs: Object.keys(filteredInputs).length ? filteredInputs : undefined,
      });
      startPendingRef.current = false;
      if (cancelRequestedRef.current) {
        void window.ade.ai.opencodeOAuthCancel({ providerId }).catch(() => undefined);
        return;
      }
      if (result.url && !isAllowedOpenCodeOAuthUrl(result.url)) {
        await window.ade.ai.opencodeOAuthCancel({ providerId }).catch(() => undefined);
        throw new Error("OpenCode returned an unsafe OAuth URL.");
      }
      openUrlInAdeBrowser(result.url);
      setStartResult(result);
      flowActiveRef.current = true;
      setPhase("waiting");
    } catch (err) {
      startPendingRef.current = false;
      if (cancelRequestedRef.current) return;
      setPhase("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancel = async () => {
    cancelRequestedRef.current = true;
    flowActiveRef.current = false;
    try {
      await window.ade.ai.opencodeOAuthCancel({ providerId });
    } catch {
      // Best-effort — closing regardless.
    }
    onClose();
  };

  const copyCode = async () => {
    const text = deviceCode ?? startResult?.instructions ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; ignore.
    }
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    fontFamily: MONO_FONT,
    textTransform: "uppercase",
    letterSpacing: "1px",
    color: COLORS.textMuted,
  };
  const fieldStyle: React.CSSProperties = {
    width: "100%",
    background: COLORS.cardBgSolid,
    border: `1px solid ${COLORS.border}`,
    color: COLORS.textPrimary,
    padding: "8px 10px",
    fontSize: 12,
    fontFamily: SANS_FONT,
    outline: "none",
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.70)" }}
      onClick={() => void handleCancel()}
    >
      <div
        role="dialog"
        aria-label={`Connect ${providerName}`}
        className="w-full max-w-md max-h-[85vh] overflow-y-auto"
        style={{
          background: COLORS.cardBgSolid,
          border: `1px solid ${COLORS.outlineBorder}`,
          boxShadow: "0 28px 80px -36px rgba(0,0,0,0.82)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
            height: 52,
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ProviderLogo family={providerId} size={22} />
            <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>
              Connect {providerName}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => void handleCancel()}
            style={{
              border: `1px solid ${COLORS.border}`,
              background: "transparent",
              color: COLORS.textSecondary,
              width: 26,
              height: 26,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <X size={13} weight="bold" />
          </button>
        </div>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          {phase === "error" ? (
            <div
              role="alert"
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "10px 12px",
                fontSize: 11,
                fontFamily: MONO_FONT,
                color: COLORS.danger,
                background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
              }}
            >
              <WarningCircle size={15} weight="fill" style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{errorMessage}</span>
            </div>
          ) : null}

          {phase === "form" || phase === "starting" ? (
            <>
              {oauthMethods.length > 1 ? (
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={labelStyle}>Method</span>
                  <select
                    value={methodIndex}
                    onChange={(event) => {
                      const nextMethodIndex = Number(event.target.value);
                      setMethodIndex(nextMethodIndex);
                      setInputs(buildPromptDefaults(methods[nextMethodIndex]?.prompts ?? []));
                    }}
                    style={fieldStyle}
                  >
                    {oauthMethods.map((entry) => (
                      <option key={entry.index} value={entry.index}>
                        {entry.method.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {visiblePrompts.map((prompt) =>
                prompt.type === "select" ? (
                  <label key={prompt.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={labelStyle}>{prompt.message}</span>
                    <select
                      value={inputs[prompt.key] ?? ""}
                      onChange={(event) => setInputs((prev) => ({ ...prev, [prompt.key]: event.target.value }))}
                      style={fieldStyle}
                    >
                      {(prompt.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                          {option.hint ? ` — ${option.hint}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label key={prompt.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={labelStyle}>{prompt.message}</span>
                    <input
                      value={inputs[prompt.key] ?? ""}
                      placeholder={prompt.placeholder}
                      onChange={(event) => setInputs((prev) => ({ ...prev, [prompt.key]: event.target.value }))}
                      style={fieldStyle}
                    />
                  </label>
                ),
              )}

              <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                We'll open your browser to finish signing in with {providerName}.
              </div>

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" style={outlineButton()} onClick={() => void handleCancel()}>
                  Cancel
                </button>
                <button
                  type="button"
                  style={primaryButton()}
                  disabled={phase === "starting"}
                  onClick={() => void startFlow()}
                >
                  {phase === "starting" ? "Opening…" : "Connect"}
                </button>
              </div>
            </>
          ) : null}

          {phase === "waiting" ? (
            <>
              <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary, lineHeight: 1.5 }}>
                {host ? `We opened ${host} in your browser.` : "We opened your browser."}
              </div>

              {deviceCode ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={labelStyle}>Enter this code</span>
                  <div
                    style={{
                      fontSize: 26,
                      fontFamily: MONO_FONT,
                      letterSpacing: "6px",
                      fontWeight: 700,
                      color: COLORS.textPrimary,
                      background: "color-mix(in srgb, var(--color-muted-fg) 12%, transparent)",
                      border: `1px solid ${COLORS.border}`,
                      padding: "12px 14px",
                      textAlign: "center",
                    }}
                  >
                    {deviceCode}
                  </div>
                </div>
              ) : startResult?.instructions ? (
                <code
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontFamily: MONO_FONT,
                    color: COLORS.textSecondary,
                    background: "color-mix(in srgb, var(--color-muted-fg) 12%, transparent)",
                    border: `1px solid ${COLORS.border}`,
                    padding: "10px 12px",
                    overflowWrap: "anywhere",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {startResult.instructions}
                </code>
              ) : null}

              <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                <li style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                  Approve the request in the page we opened.
                </li>
                {deviceCode ? (
                  <li style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                    Confirm the code above matches.
                  </li>
                ) : null}
                <li style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                  Return here — this closes automatically once approved.
                </li>
              </ol>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11,
                  fontFamily: MONO_FONT,
                  color: COLORS.info,
                }}
              >
                <Info size={14} weight="fill" />
                Waiting for approval…
              </div>

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                {deviceCode || startResult?.instructions ? (
                  <button type="button" style={outlineButton()} onClick={() => void copyCode()}>
                    {copied ? <CheckCircle size={13} weight="fill" /> : <Copy size={13} weight="bold" />}
                    {copied ? "Copied" : "Copy code"}
                  </button>
                ) : null}
                <button type="button" style={outlineButton()} onClick={() => void handleCancel()}>
                  Cancel
                </button>
              </div>
            </>
          ) : null}

          {phase === "error" ? (
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" style={outlineButton()} onClick={() => void handleCancel()}>
                Close
              </button>
              <button
                type="button"
                style={primaryButton()}
                onClick={() => {
                  setPhase("form");
                  setErrorMessage(null);
                  setStartResult(null);
                }}
              >
                Try again
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
