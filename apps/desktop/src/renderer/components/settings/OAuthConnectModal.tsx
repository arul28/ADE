import React, { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, Copy, Info, WarningCircle } from "@phosphor-icons/react";
import type {
  OpenCodeProviderAuthMethod,
  OpenCodeProviderAuthPrompt,
  OpenCodeOAuthStartResult,
  OpenCodeOAuthStatusEvent,
} from "../../../shared/types/config";
import { isAllowedOpenCodeOAuthUrl } from "../../../shared/opencodeOAuth";
import { openExternalUrl, openUrlInAdeBrowser } from "../../lib/openExternal";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ProviderLogo } from "../shared/ProviderLogos";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { Dialog, DialogActions, type DialogAction } from "../ui/dialog";

const CODE_PATTERN = /[A-Z0-9]{4,}-[A-Z0-9]{4,}/;
const OPEN_TARGET_STORAGE_KEY = "ade.opencode.oauthOpenTarget";

/** How the OAuth URL should be delivered to the user. */
export type OAuthOpenTarget = "ade-browser" | "system" | "copy" | "view";

const OPEN_TARGET_OPTIONS: Array<{ id: OAuthOpenTarget; label: string }> = [
  { id: "system", label: "System browser" },
  { id: "ade-browser", label: "ADE browser" },
  { id: "copy", label: "Copy link" },
  { id: "view", label: "View full link" },
];

function isOAuthOpenTarget(value: string | null): value is OAuthOpenTarget {
  return OPEN_TARGET_OPTIONS.some((option) => option.id === value);
}

function readStoredOpenTarget(): OAuthOpenTarget {
  try {
    const raw = localStorage.getItem(OPEN_TARGET_STORAGE_KEY);
    if (isOAuthOpenTarget(raw)) return raw;
  } catch {
    // ignore
  }
  return "system";
}

function writeStoredOpenTarget(target: OAuthOpenTarget): void {
  try {
    localStorage.setItem(OPEN_TARGET_STORAGE_KEY, target);
  } catch {
    // ignore
  }
}

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

function applyOpenTarget(
  url: string,
  target: OAuthOpenTarget,
  onCopy: (url: string) => void,
): void {
  if (!url) return;
  switch (target) {
    case "ade-browser":
      openUrlInAdeBrowser(url);
      return;
    case "system":
      openExternalUrl(url);
      return;
    case "copy":
      onCopy(url);
      return;
    case "view":
      return;
  }
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
  const [openTarget, setOpenTarget] = useState<OAuthOpenTarget>(() => readStoredOpenTarget());
  const [phase, setPhase] = useState<Phase>("form");
  const [startResult, setStartResult] = useState<OpenCodeOAuthStartResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showFullUrl, setShowFullUrl] = useState(false);
  const { copy, isCopied } = useCopyToClipboard();

  const copyText = async (text: string, kind: "url" | "code") => {
    if (!text) return;
    await copy(text, kind);
  };

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

  const startFlow = async () => {
    cancelRequestedRef.current = false;
    startPendingRef.current = true;
    writeStoredOpenTarget(openTarget);
    setPhase("starting");
    setErrorMessage(null);
    setShowFullUrl(openTarget === "view");
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
      if (result.url) {
        applyOpenTarget(result.url, openTarget, (url) => {
          void copyText(url, "url");
        });
      }
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
    await copyText(text, "code");
  };

  const copyUrl = async () => {
    if (!startResult?.url) return;
    await copyText(startResult.url, "url");
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

  const waitingHint =
    openTarget === "ade-browser"
      ? host
        ? `We opened ${host} in ADE’s browser.`
        : "We opened ADE’s browser."
      : openTarget === "system"
        ? host
          ? `We opened ${host} in your system browser.`
          : "We opened your system browser."
      : openTarget === "copy"
        ? isCopied("url")
          ? "Sign-in link copied — paste it where you can complete login."
          : "Use the full link below to finish signing in."
          : "Use the full link below to finish signing in.";

  const resetToForm = () => {
    setPhase("form");
    setErrorMessage(null);
    setStartResult(null);
  };
  const cancelAction: DialogAction = { label: "Cancel", onClick: () => void handleCancel(), variant: "secondary" };
  const footerActions: DialogAction[] =
    phase === "form" || phase === "starting"
      ? [
          cancelAction,
          {
            label: phase === "starting" ? "Starting…" : "Connect",
            onClick: () => void startFlow(),
            disabled: phase === "starting",
            variant: "solid",
          },
        ]
      : phase === "waiting"
        ? [
            ...(startResult?.url
              ? [{
                  label: isCopied("url") ? "Link copied" : "Copy link",
                  icon: isCopied("url") ? <CheckCircle size={13} weight="fill" /> : <Copy size={13} weight="bold" />,
                  onClick: () => void copyUrl(),
                  variant: "secondary" as const,
                }]
              : []),
            ...(deviceCode || startResult?.instructions
              ? [{
                  label: isCopied("code") ? "Code copied" : "Copy code",
                  icon: isCopied("code") ? <CheckCircle size={13} weight="fill" /> : <Copy size={13} weight="bold" />,
                  onClick: () => void copyCode(),
                  variant: "secondary" as const,
                }]
              : []),
            ...(startResult?.url
              ? [{ label: "System browser", onClick: () => openExternalUrl(startResult.url), variant: "secondary" as const }]
              : []),
            cancelAction,
          ]
        : [
            { label: "Close", onClick: () => void handleCancel(), variant: "secondary" },
            { label: "Try again", onClick: resetToForm, variant: "solid" },
          ];

  // Raised from inside the provider detail dialog, so it sits one layer up.
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) void handleCancel();
      }}
      layer="nestedDialog"
      // JSX title keeps the close button's plain "Close" label.
      title={<>Connect {providerName}</>}
      icon={<ProviderLogo family={providerId} size={18} />}
      tone="accent"
      width={448}
      maxHeight="85vh"
      preventAutoFocus
      bodyStyle={{ display: "flex", flexDirection: "column", gap: 14 }}
      footer={
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
          <DialogActions actions={footerActions} tone="accent" />
        </div>
      }
    >
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

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labelStyle}>Open sign-in link in</span>
            <select
              aria-label="Open sign-in link in"
              value={openTarget}
              onChange={(event) => setOpenTarget(event.target.value as OAuthOpenTarget)}
              style={fieldStyle}
            >
              {OPEN_TARGET_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
            OpenCode completes sign-in on the machine running the runtime. This dialog closes automatically after approval.
          </div>
        </>
      ) : null}

      {phase === "waiting" ? (
        <>
          <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary, lineHeight: 1.5 }}>
            {waitingHint}
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

          {startResult?.url ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={labelStyle}>Sign-in link</span>
                <button
                  type="button"
                  style={{ ...outlineButton({ height: 24, padding: "0 8px", fontSize: 10 }), border: "none" }}
                  onClick={() => setShowFullUrl((v) => !v)}
                >
                  {showFullUrl ? "Hide" : "View full link"}
                </button>
              </div>
              {showFullUrl ? (
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
                    wordBreak: "break-all",
                  }}
                >
                  {startResult.url}
                </code>
              ) : null}
            </div>
          ) : null}

          <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
            <li style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
              Approve the request in the sign-in page.
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
        </>
      ) : null}
    </Dialog>
  );
}
