import React, { useMemo, useRef, useState } from "react";
import { CheckCircle, CloudCheck, XCircle } from "@phosphor-icons/react";
import type { AiApiKeyVerificationResult } from "../../../shared/types";
import type { OpenCodeProviderAuthMethod } from "../../../shared/types/config";
import { openCodeSignInViaProvider } from "../../../shared/opencodeProviders";
import { COLORS, MONO_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { OAuthConnectModal } from "./OAuthConnectModal";
import { ProviderDetailDialog } from "./providerSectionPrimitives";
import { Banner } from "../ui/notice/Banner";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import {
  OpenCodeAccountsSection,
  OpenCodeAddAccountDialog,
  useOpenCodeAccounts,
} from "./providers/opencode/OpenCodeAccounts";
import { isImeComposing } from "../../lib/imeComposition";

export type OpenCodeProviderDetail = {
  id: string;
  name: string;
  methods: OpenCodeProviderAuthMethod[];
  connected: boolean;
  /** OpenCode holds a login for it. `connected` alone can mean free models. */
  signedIn?: boolean;
  hasKey: boolean;
  modelCount?: number;
  /** Non-secret environment variable names advertised by OpenCode. */
  envVars?: string[];
  /** Non-secret source of an API credential visible to ADE. */
  credentialSource?: ApiKeySource;
  /** True only when ADE has a provider-native API-key verifier. */
  verificationSupported?: boolean;
  /** Legacy singular field kept for ADE's curated provider rows. */
  envVar?: string;
  placeholder?: string;
};

/** `host`: a key an SDK host supplied for this run, held in memory only. */
export type ApiKeySource = "config" | "env" | "store" | "host";

/** Another provider's sign-in, for a provider with none of its own. */
export type OpenCodeSignInVia = { providerId: string; providerName: string; methods: OpenCodeProviderAuthMethod[] };

/**
 * The open detail view's row and the sign-in it borrows, if any (OpenCode Go
 * signs in through `opencode`). The row outlives a refresh that briefly drops
 * it, so the dialog, and any sign-in running inside it, is not unmounted.
 */
export function useOpenCodeProviderDetail(
  detailProviderId: string | null,
  catalog: readonly OpenCodeProviderDetail[],
): { provider: OpenCodeProviderDetail | null; signInVia: OpenCodeSignInVia | undefined } {
  const lastRef = useRef<OpenCodeProviderDetail | null>(null);
  const provider = useMemo(() => {
    if (!detailProviderId) return null;
    const found = catalog.find((p) => p.id === detailProviderId);
    if (found) return found;
    return lastRef.current?.id === detailProviderId ? lastRef.current : null;
  }, [detailProviderId, catalog]);
  lastRef.current = provider;
  const signInVia = useMemo((): OpenCodeSignInVia | undefined => {
    const viaId = provider ? openCodeSignInViaProvider(provider.id) : null;
    const via = viaId ? catalog.find((p) => p.id === viaId) : undefined;
    if (!via?.methods.some((m) => m.type === "oauth")) return undefined;
    return { providerId: via.id, providerName: via.name, methods: via.methods };
  }, [provider, catalog]);
  return { provider, signInVia };
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: COLORS.textMuted,
};

export function OpenCodeProviderDetailModal({
  provider,
  signInVia,
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
  /**
   * Sign in through another provider's methods, for a provider with no sign-in
   * of its own (`openCodeSignInViaProvider` in `shared/opencodeProviders.ts`).
   */
  signInVia?: OpenCodeSignInVia;
}) {
  const signInTarget = signInVia ?? { providerId: provider.id, providerName: provider.name, methods: provider.methods };
  const oauthMethods = useMemo(
    () => signInTarget.methods.filter((m) => m.type === "oauth"),
    [signInTarget.methods],
  );
  const cloudMethods = useMemo(
    () => signInTarget.methods.filter((m) => m.type === "cloud"),
    [signInTarget.methods],
  );
  // Logins live on the machine this Settings page is showing.
  const { pin, machineName, isThisMachine } = useSettingsMachineScope();
  // How the machine reads inside a sentence: "Ready on this computer".
  const machineLabel = isThisMachine ? "this computer" : machineName;
  // A machine whose ADE predates accounts cannot list them; the dialog then
  // keeps its plain sign-in, which still works there.
  const accountsState = useOpenCodeAccounts(signInTarget.providerId, pin);
  const accounts = accountsState.accounts;
  const [addingAccount, setAddingAccount] = useState(false);
  const credentialEnvVars = provider.envVars?.length
    ? provider.envVars
    : provider.envVar
      ? [provider.envVar]
      : [];
  // Prefer live OpenCode auth methods when present. Fall back to ADE's known
  // env-key catalog only when OpenCode has not advertised methods yet (or only
  // OAuth was advertised for a dual-auth provider we also list in API_KEY_PROVIDERS).
  const supportsApi =
    provider.methods.some((m) => m.type === "api")
    || credentialEnvVars.length > 0;
  const canVerify = provider.verificationSupported === true;
  // Connected OpenCode sessions (OAuth or key mirrored into OpenCode) must always
  // offer Disconnect — even when auth-method discovery failed and methods[] is empty.
  const externallyManaged = keySource === "env" || keySource === "config";
  // A provider signed in through another one is disconnected there, not here.
  const canDisconnect = !externallyManaged && ((!signInVia && provider.connected) || keySource === "store");
  const showOauthSection = oauthMethods.length > 0 || cloudMethods.length > 0 || (provider.connected && !provider.hasKey);
  // A provider with free models is usable before any sign-in. With a sign-in
  // on offer, "Connected via OpenCode" is claimed only for a real login or key.
  // Through another provider's sign-in, this provider's own models are the proof.
  const signedIn = signInVia
    ? provider.connected
    : oauthMethods.length > 0
      ? provider.signedIn === true || provider.hasKey
      : provider.connected;
  // The sign-in dialog runs against the target it opened with: a refresh that
  // changes `signInVia` mid-flow must not retarget it, which would cancel the
  // running sign-in and filter out its "connected" event.
  const [oauthTarget, setOauthTarget] = useState<(OpenCodeSignInVia & { methodIndex?: number }) | null>(null);
  const openOauth = () => setOauthTarget(signInTarget);
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

  // Escape, focus-in, and focus-restore are owned by ProviderDetailDialog; the
  // nested OAuth dialog stacks above it and takes them while it is open.

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
        onClose={onClose}
      >
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
              {error ? (
                <Banner layout="inline" model={{ id: "opencode-provider-error", tone: "error", title: error }} />
              ) : null}

              {authMethodsError && oauthMethods.length === 0 && !provider.hasKey && (provider.connected || !supportsApi) ? (
                <Banner
                  layout="inline"
                  model={{
                    id: "opencode-auth-methods-warning",
                    tone: "warning",
                    title: `Could not load OpenCode sign-in methods (${authMethodsError}). SuperGrok, ChatGPT, and Copilot OAuth may be unavailable until this succeeds.`,
                    actions: onRetryAuthMethods
                      ? [{ label: "Retry sign-in methods", onClick: onRetryAuthMethods, variant: "secondary" }]
                      : undefined,
                  }}
                />
              ) : null}

              {accounts.length === 0 && accountsState.error && !accountsState.loading ? (
                // The plain sign-in below still works (a machine on an older
                // ADE has no account list to give); say the list is missing.
                <Banner
                  layout="inline"
                  model={{
                    id: `opencode-accounts-load-${signInTarget.providerId}`,
                    tone: "warning",
                    title: `Could not load ${signInTarget.providerName} accounts on ${machineLabel}.`,
                    actions: [{ label: "Retry", onClick: () => void accountsState.reload(), variant: "secondary" }],
                  }}
                />
              ) : null}

              {accounts.length > 0 ? (
                <OpenCodeAccountsSection
                  providerId={signInTarget.providerId}
                  providerName={signInTarget.providerName}
                  machineName={machineLabel}
                  pin={pin}
                  accounts={accounts}
                  loading={accountsState.loading}
                  error={accountsState.error}
                  reload={accountsState.reload}
                  onAddAccount={() => setAddingAccount(true)}
                  onChanged={onConnected}
                />
              ) : null}

              {accounts.length > 0 && canDisconnect ? (
                <div className="ade-oc-acct-footer">
                  <button
                    type="button"
                    className="kit-btn kit-btn-ghost"
                    data-size="sm"
                    data-tone="crit"
                    disabled={busy}
                    onClick={() => void remove()}
                    aria-label={`Disconnect ${provider.name}`}
                  >
                    Sign out of all
                  </button>
                </div>
              ) : null}

              {showOauthSection && accounts.length === 0 ? (
                <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={sectionLabelStyle}>{oauthMethods.length > 0 ? "Subscription / OAuth" : "Sign in"}</div>
                  {oauthMethods.length > 0 || cloudMethods.length > 0 ? (
                    <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                      {signInVia
                        ? `${provider.name} comes with your opencode.ai account. Sign in with it, as \`opencode auth login opencode\` does.`
                        : [...oauthMethods, ...cloudMethods].map((m) => m.label).join(" · ")}
                    </div>
                  ) : provider.connected ? (
                    <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                      {canDisconnect
                        ? "Connected in OpenCode. Sign-in methods could not be listed — you can still disconnect."
                        : "Connected by a credential managed outside ADE. Clear that env/config value to disconnect."}
                    </div>
                  ) : null}
                  {provider.connected && !signedIn ? (
                    <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                      Free models work without signing in.
                    </div>
                  ) : null}
                  {signedIn ? (
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
                            onClick={openOauth}
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
                  ) : oauthMethods.length > 0 || cloudMethods.length > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {oauthMethods.length > 0 ? (
                        <button
                          type="button"
                          style={primaryButton()}
                          disabled={busy}
                          onClick={openOauth}
                          aria-label={`Sign in to ${provider.name}`}
                        >
                          Sign in
                        </button>
                      ) : null}
                      {cloudMethods.length > 0 ? (
                        <button
                          type="button"
                          className="kit-btn"
                          disabled={busy}
                          onClick={() => setAddingAccount(true)}
                          aria-label={`Use a cloud login for ${provider.name}`}
                        >
                          <CloudCheck size={13} /> Use a cloud login
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {supportsApi ? (
                <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={sectionLabelStyle}>API key</div>
                  {accounts.length > 0 && provider.hasKey ? (
                    <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                      Not used while an account above is signed in. Sign out of all of them to use this key.
                    </div>
                  ) : null}
                  {signInVia ? (
                    <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                      Optional. The sign-in above is enough; a key is only for a setup without it.
                    </div>
                  ) : null}
                  {credentialEnvVars.length > 0 ? (
                    <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                      {credentialEnvVars.join(" · ")}
                    </div>
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
                          if (isImeComposing(event)) return;
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
                          {canVerify && verifying ? (
                            <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.info }}>Checking…</span>
                          ) : canVerify && verification?.ok ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.success }}>
                              <CheckCircle size={12} weight="fill" /> Verified
                            </span>
                          ) : canVerify && verification && !verification.ok ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.danger }} title={verification.message}>
                              <XCircle size={12} weight="fill" /> Failed
                            </span>
                          ) : keySource ? (
                            <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                              From {keySource}
                            </span>
                          ) : null}
                          {canVerify ? (
                            <button type="button" style={outlineButton({ height: 28 })} disabled={busy || verifying} onClick={() => void onVerifyKey()}>
                              Verify
                            </button>
                          ) : null}
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

      {oauthTarget ? (
        <OAuthConnectModal
          providerId={oauthTarget.providerId}
          providerName={oauthTarget.providerName}
          methods={oauthTarget.methods}
          initialMethodIndex={oauthTarget.methodIndex}
          onClose={() => setOauthTarget(null)}
          onConnected={() => {
            setOauthTarget(null);
            void accountsState.reload();
            onConnected();
          }}
        />
      ) : null}

      {addingAccount ? (
        <OpenCodeAddAccountDialog
          providerId={signInTarget.providerId}
          providerName={signInTarget.providerName}
          methods={signInTarget.methods}
          pin={pin}
          onClose={() => setAddingAccount(false)}
          onStartOAuth={(methodIndex) => {
            setAddingAccount(false);
            setOauthTarget({ ...signInTarget, methodIndex });
          }}
          onAdded={() => {
            setAddingAccount(false);
            void accountsState.reload();
            onConnected();
          }}
        />
      ) : null}
    </>
  );
}
