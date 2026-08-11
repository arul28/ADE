import React, { useMemo, useState } from "react";
import { CheckCircle, XCircle } from "@phosphor-icons/react";
import type { AiApiKeyVerificationResult } from "../../../shared/types";
import type { OpenCodeProviderAuthMethod } from "../../../shared/types/config";
import { COLORS, MONO_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { OAuthConnectModal } from "./OAuthConnectModal";
import { ProviderDetailDialog } from "./providerSectionPrimitives";

export type OpenCodeProviderDetail = {
  id: string;
  name: string;
  methods: OpenCodeProviderAuthMethod[];
  connected: boolean;
  hasKey: boolean;
  modelCount?: number;
  envVar?: string;
  placeholder?: string;
};

export type ApiKeySource = "config" | "env" | "store";

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: COLORS.textMuted,
};

export function OpenCodeProviderDetailModal({
  provider,
  keySource,
  verification,
  verifying,
  authMethodsError,
  onClose,
  onConnected,
  onRetryAuthMethods,
  onSaveKey,
  onDeleteKey,
  onVerifyKey,
}: {
  provider: OpenCodeProviderDetail;
  keySource?: ApiKeySource;
  verification?: AiApiKeyVerificationResult;
  verifying?: boolean;
  /** When set, OpenCode auth-method discovery failed (SuperGrok / ChatGPT OAuth may be missing). */
  authMethodsError?: string | null;
  onClose: () => void;
  onConnected: () => void;
  onRetryAuthMethods?: () => void;
  onSaveKey: (key: string) => Promise<void>;
  onDeleteKey: () => Promise<void>;
  onVerifyKey: () => Promise<void>;
}) {
  const oauthMethods = useMemo(
    () => provider.methods.filter((m) => m.type === "oauth"),
    [provider.methods],
  );
  // Prefer live OpenCode auth methods when present. Fall back to ADE's known
  // env-key catalog only when OpenCode has not advertised methods yet (or only
  // OAuth was advertised for a dual-auth provider we also list in API_KEY_PROVIDERS).
  const supportsApi =
    provider.methods.some((m) => m.type === "api")
    || Boolean(provider.envVar);
  // Connected OpenCode sessions (OAuth or key mirrored into OpenCode) must always
  // offer Disconnect — even when auth-method discovery failed and methods[] is empty.
  const canDisconnect = provider.connected || keySource === "store";
  const showOauthSection = oauthMethods.length > 0 || (provider.connected && !provider.hasKey);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusLabel = provider.connected
    ? "Connected"
    : provider.hasKey
      ? "Key on file"
      : oauthMethods.length > 0
        ? "Sign-in available"
        : "Not connected";

  // Escape, focus-in, and focus-restore are owned by ProviderDetailDialog,
  // which stands down while the nested OAuth modal is open.

  const save = async () => {
    const trimmed = keyValue.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onSaveKey(trimmed);
      setEditing(false);
      setKeyValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDeleteKey();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ProviderDetailDialog
        providerId={provider.id}
        title={provider.name}
        subtitle={`${statusLabel}${typeof provider.modelCount === "number" ? ` \u00b7 ${provider.modelCount} models` : ""}`}
        suspended={oauthOpen}
        onClose={onClose}
      >
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
              {error ? (
                <div
                  role="alert"
                  style={{
                    fontSize: 11,
                    fontFamily: MONO_FONT,
                    color: COLORS.danger,
                    padding: "8px 10px",
                    border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
                    background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
                  }}
                >
                  {error}
                </div>
              ) : null}

              {authMethodsError && oauthMethods.length === 0 && !provider.hasKey && (provider.connected || !supportsApi) ? (
                <div
                  role="status"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    fontSize: 11,
                    fontFamily: MONO_FONT,
                    color: COLORS.warning,
                    padding: "8px 10px",
                    border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
                    background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
                    lineHeight: 1.45,
                  }}
                >
                  <span>
                    Could not load OpenCode sign-in methods
                    ({authMethodsError}). SuperGrok, ChatGPT, and Copilot OAuth may be unavailable until this succeeds.
                  </span>
                  {onRetryAuthMethods ? (
                    <button
                      type="button"
                      style={outlineButton({ height: 28, alignSelf: "flex-start" })}
                      onClick={onRetryAuthMethods}
                    >
                      Retry sign-in methods
                    </button>
                  ) : null}
                </div>
              ) : null}

              {showOauthSection ? (
                <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={sectionLabelStyle}>Subscription / OAuth</div>
                  {oauthMethods.length > 0 ? (
                    <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                      {oauthMethods.map((m) => m.label).join(" · ")}
                    </div>
                  ) : provider.connected ? (
                    <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                      Connected in OpenCode. Sign-in methods could not be listed — you can still disconnect.
                    </div>
                  ) : null}
                  {provider.connected ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, color: COLORS.success, fontSize: 11, fontFamily: MONO_FONT }}>
                        <CheckCircle size={14} weight="fill" /> Connected via OpenCode
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {oauthMethods.length > 0 ? (
                          <button
                            type="button"
                            style={outlineButton({ height: 28 })}
                            disabled={busy}
                            onClick={() => setOauthOpen(true)}
                            aria-label={`Sign in again to ${provider.name}`}
                          >
                            Sign in again
                          </button>
                        ) : null}
                        {canDisconnect ? (
                          <button
                            type="button"
                            style={{ ...outlineButton({ height: 28 }), color: COLORS.danger }}
                            disabled={busy}
                            onClick={() => void remove()}
                            aria-label={`Disconnect ${provider.name}`}
                          >
                            Disconnect
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : oauthMethods.length > 0 ? (
                    <button
                      type="button"
                      style={primaryButton()}
                      disabled={busy}
                      onClick={() => setOauthOpen(true)}
                      aria-label={`Sign in to ${provider.name}`}
                    >
                      Sign in
                    </button>
                  ) : null}
                </section>
              ) : null}

              {supportsApi ? (
                <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={sectionLabelStyle}>API key</div>
                  {provider.envVar ? (
                    <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>{provider.envVar}</div>
                  ) : null}

                  {editing ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <input
                        autoFocus
                        type="password"
                        aria-label={`${provider.name} API key`}
                        value={keyValue}
                        placeholder={provider.placeholder ?? "API key"}
                        onChange={(event) => setKeyValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && keyValue.trim() && !busy) {
                            event.preventDefault();
                            void save();
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
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button type="button" style={outlineButton()} disabled={busy} onClick={() => { setEditing(false); setKeyValue(""); }}>
                          Cancel
                        </button>
                        <button type="button" style={primaryButton()} disabled={busy || !keyValue.trim()} onClick={() => void save()}>
                          {busy ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      {provider.hasKey ? (
                        <>
                          {verifying ? (
                            <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.info }}>Checking…</span>
                          ) : verification?.ok ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.success }}>
                              <CheckCircle size={12} weight="fill" /> Verified
                            </span>
                          ) : verification && !verification.ok ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.danger }} title={verification.message}>
                              <XCircle size={12} weight="fill" /> Failed
                            </span>
                          ) : keySource ? (
                            <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                              From {keySource}
                            </span>
                          ) : null}
                          <button type="button" style={outlineButton({ height: 28 })} disabled={busy || verifying} onClick={() => void onVerifyKey()}>
                            Verify
                          </button>
                          {keySource === "store" || (!keySource && provider.hasKey) ? (
                            <>
                              <button type="button" style={outlineButton({ height: 28 })} disabled={busy} onClick={() => setEditing(true)}>
                                Replace
                              </button>
                              <button type="button" style={{ ...outlineButton({ height: 28 }), color: COLORS.danger }} disabled={busy} onClick={() => void remove()}>
                                Delete
                              </button>
                            </>
                          ) : keySource === "env" || keySource === "config" ? (
                            <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                              Managed outside ADE — clear the env/config value to remove.
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <button
                          type="button"
                          style={outlineButton({ height: 28 })}
                          disabled={busy}
                          onClick={() => setEditing(true)}
                          aria-label={`Add ${provider.name} key`}
                        >
                          Add key
                        </button>
                      )}
                    </div>
                  )}
                </section>
              ) : null}

              {!showOauthSection && !supportsApi ? (
                <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                  No sign-in methods or API key fields are available for this provider yet. Refresh the catalog or retry sign-in methods.
                </div>
              ) : null}
            </div>
      </ProviderDetailDialog>

      {oauthOpen ? (
        <OAuthConnectModal
          providerId={provider.id}
          providerName={provider.name}
          methods={provider.methods}
          onClose={() => setOauthOpen(false)}
          onConnected={() => {
            setOauthOpen(false);
            onConnected();
          }}
        />
      ) : null}
    </>
  );
}
