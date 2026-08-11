/**
 * Settings → Providers, Pi half: the sign-in flow and the provider catalog.
 *
 * Its own module because Pi's catalog is the same size as OpenCode's and the
 * two together pushed `ProvidersSection.tsx` well past the point where either
 * could be read on its own. The catalog primitives both halves share live in
 * `providerSectionPrimitives.tsx`.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiPiInstallationStatus,
  AiPiProviderStatus,
  AiProviderConnectionStatus,
  AiRuntimeConnections,
  AiRuntimeConnectionStatus,
} from "../../../shared/types";
import type { PiAuthNotice, PiAuthPrompt, PiLoginMethod, PiLoginProvider } from "../../../shared/types/config";
import { decodePiRegistryId } from "../../../shared/modelRegistry";
import { ProviderLogo } from "../shared/ProviderLogos";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  SECTION_LABEL_STYLE,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { openExternalUrl } from "../../lib/openExternal";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ArrowsClockwise } from "@phosphor-icons/react";
import {
  ConnectedTag,
  ProviderGrid,
  ProviderSearchField,
  ProviderTile,
  ProviderTileBadge,
  panel,
} from "./providerSectionPrimitives";
import { PiProviderDetailModal } from "./PiProviderDetailModal";
import {
  piProviderIsConnected,
  piProviderModelCount,
  runtimeConnectionForPiProvider,
  type PiProviderRow,
} from "./piProviderRow";

export function getPiTone(
  connection: AiProviderConnectionStatus | null | undefined,
  installation: AiPiInstallationStatus | null | undefined,
): { color: string; label: string } {
  if (!installation?.installed && !connection?.runtimeDetected) {
    return { color: COLORS.textDim, label: "Not detected" };
  }
  if (installation?.installed && !installation.sdkAvailable) {
    return { color: COLORS.warning, label: "SDK needed" };
  }
  if (connection?.runtimeAvailable) {
    return { color: COLORS.success, label: "Ready" };
  }
  if (installation?.sdkAvailable && connection?.authAvailable) {
    return { color: COLORS.warning, label: "Configured" };
  }
  if (installation?.sdkAvailable || installation?.cliAvailable) {
    return { color: COLORS.warning, label: "Sign-in required" };
  }
  return { color: COLORS.danger, label: "Unavailable" };
}

export function buildPiMessage(
  connection: AiProviderConnectionStatus | null | undefined,
  installation: AiPiInstallationStatus | null | undefined,
): string {
  if (!installation) {
    return "Checking Pi installation and provider inventory.";
  }
  const configuredProviders = installation.providers.filter((provider) => provider.configured).length;
  const availableModels = installation.availableModelIds.length;
  if (connection?.runtimeAvailable) {
    const version = installation.version ? `Pi ${installation.version}` : "Pi";
    return `${version} is installed. ${availableModels} model${availableModels === 1 ? " is" : "s are"} available across ${configuredProviders} configured provider${configuredProviders === 1 ? "" : "s"}.`;
  }
  if (connection?.blocker) {
    return connection.blocker;
  }
  if (installation.installed && !installation.sdkAvailable) {
    return installation.blocker
      ?? "Pi CLI is available, but ADE's Pi SDK package is missing. Install @earendil-works/pi-coding-agent or set ADE_PI_PACKAGE_ROOT.";
  }
  if (!installation.installed) {
    return "Pi is not installed for this user yet. Install @earendil-works/pi-coding-agent, then use Refresh. Pi keeps its own credentials and profile.";
  }
  return "Pi is installed, but no configured providers or available models were detected yet.";
}

type PiSignInFlow = {
  /** Identifies this attempt, so a superseded start cannot tear down its replacement. */
  attemptId: number;
  providerId: string;
  /** Kept so a failed flow can be retried with the button the user actually pressed. */
  method: PiLoginMethod | null;
  prompt: PiAuthPrompt | null;
  /** Sticky auth URL / device code the user still has to act on. */
  link: PiAuthNotice | null;
  progress: string | null;
};

/** Cancelling is a choice, not a failure, so it gets its own state instead of an error. */
type PiSignInOutcome = {
  providerId: string;
  method: PiLoginMethod | null;
  state: "ok" | "cancelled" | "error";
  error?: string;
};

/** Pi only sends options for select prompts; every other kind takes free text. */
function piChoiceOptions(prompt: PiAuthPrompt | null | undefined): NonNullable<PiAuthPrompt["options"]> {
  return prompt?.options ?? [];
}

/** Merges both provider sources by id so a signable, configured provider is one row, not two. */
function buildPiProviderRows(configured: AiPiProviderStatus[], signable: PiLoginProvider[]): PiProviderRow[] {
  const rows = new Map<string, PiProviderRow>();
  for (const status of configured) {
    rows.set(status.id, { id: status.id, name: status.name, status, login: null });
  }
  for (const login of signable) {
    const existing = rows.get(login.id);
    if (existing) existing.login = login;
    else rows.set(login.id, { id: login.id, name: login.name, status: null, login });
  }
  return [...rows.values()];
}

/**
 * Compact provider tile, the same shape OpenCode uses. Everything a provider
 * can do lives behind it: with roughly forty Pi providers, expanding them all
 * inline buried the handful the user actually has.
 */
function PiProviderCard({ provider, onOpen }: { provider: PiProviderRow; onOpen: () => void }) {
  const connected = piProviderIsConnected(provider);
  const modelCount = piProviderModelCount(provider);
  const noModels = connected && provider.status != null && provider.status.availableModelCount === 0;
  const badge = connected
    ? "Connected"
    : provider.login?.authTypes.includes("oauth")
      ? "OAuth"
      : provider.login?.authTypes.includes("api_key")
        ? "Key"
        : "Details";
  return (
    <ProviderTile
      id={provider.id}
      name={provider.name}
      // Qualified because the same provider can appear in both the Pi and the
      // OpenCode grid, and two buttons named "Connect xAI" on one page tell a
      // screen-reader user nothing about which harness they are configuring.
      ariaLabel={connected ? `Open ${provider.name} in Pi` : `Connect ${provider.name} in Pi`}
      badge={connected ? <ConnectedTag /> : <ProviderTileBadge>{badge}</ProviderTileBadge>}
      onOpen={onOpen}
      footer={noModels ? (
        <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.warning }}>No models</div>
      ) : typeof modelCount === "number" ? (
        <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
          {modelCount} model{modelCount === 1 ? "" : "s"}
        </div>
      ) : undefined}
    />
  );
}

/**
 * A model server the user runs. These have no credential to collect — offering
 * an API key field for a localhost endpoint is the wrong question — so the card
 * reports whether ADE can reach it and where.
 */
/**
 * What ADE's probe actually found, in the same words the OpenCode section
 * uses — a local server is reachable, reachable-but-idle, or not answering.
 */
function piLocalServerTone(
  connection: AiRuntimeConnectionStatus | null,
  provider: PiProviderRow,
): { color: string; label: string } {
  // ADE only probes ollama and lmstudio. For any other loopback server, Pi's
  // own profile is the best evidence there is — reporting "Not checked"
  // forever would be worse than saying what the profile knows.
  if (!connection) {
    return piProviderIsConnected(provider)
      ? { color: COLORS.textMuted, label: "Configured in Pi" }
      : { color: COLORS.textDim, label: "Not configured" };
  }
  switch (connection.health) {
    case "ready":
      return { color: COLORS.success, label: "Running" };
    case "reachable":
    case "reachable_no_models":
      return { color: COLORS.warning, label: "Load a model" };
    case "not_configured":
      return { color: COLORS.textMuted, label: "Not configured" };
    default:
      return { color: COLORS.textDim, label: "Not detected" };
  }
}

function PiLocalServerCard({
  provider,
  connection,
}: {
  provider: PiProviderRow;
  connection: AiRuntimeConnectionStatus | null;
}) {
  const endpoint = connection?.endpoint ?? provider.status?.baseUrl ?? null;
  // Reported from ADE's live probe, never from the presence of a config entry.
  // A server listed in models.json that nothing is listening on is not
  // "connected", and saying so was the whole complaint.
  const tone = piLocalServerTone(connection, provider);
  return (
    <div style={{ ...panel({ padding: 10 }), borderLeft: `3px solid ${tone.color}`, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <ProviderLogo family={provider.id} size={20} />
          <span style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {provider.name}
          </span>
        </div>
        <span style={{ fontSize: 9, fontFamily: MONO_FONT, color: tone.color, textTransform: "uppercase", letterSpacing: "0.6px" }}>
          {tone.label}
        </span>
      </div>
      {endpoint ? (
        <code style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, overflowWrap: "anywhere" }}>
          {endpoint}
        </code>
      ) : null}
      {connection?.blocker ? (
        <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, lineHeight: 1.5 }}>{connection.blocker}</div>
      ) : null}
    </div>
  );
}

/**
 * Shown only when ADE cannot run Pi's SDK, which is the one case in-app
 * sign-in is impossible. ADE used to open a terminal and type `/login` into
 * Pi's TUI after a fixed delay; that raced Pi's startup and usually submitted
 * empty lines, so the instruction is stated instead of automated.
 */
function PiTerminalFallback({ installation }: { installation: AiPiInstallationStatus }) {
  return (
    <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, lineHeight: 1.5 }}>
      {installation.cliAvailable
        ? "Signing in from ADE needs Pi's SDK. Until the blocker above is resolved, run pi in a terminal and use its /login command."
        : "Install Pi to sign in."}
    </span>
  );
}

/**
 * Runs Pi's own sign-in inside ADE: pick a provider, then answer whatever Pi
 * asks. Pi writes the credential itself — nothing typed here is kept by ADE.
 */
/**
 * Pi's provider catalog: what is connected, everything else behind a search,
 * and the local model servers that have no credential to collect.
 *
 * Deliberately reads no sign-in state — the panel replaces it wholesale while
 * a flow is on screen — which is what makes it separable from the flow card.
 */
function PiProviderBrowser({
  providers,
  providersError,
  signableProviders,
  allRows,
  connectedRows,
  popularRows,
  searchedRows,
  localRows,
  runtimeConnections,
  providerSearch,
  onProviderSearchChange,
  loadingProviders,
  onRefreshDetection,
  onOpenProvider,
}: {
  providers: PiLoginProvider[] | null;
  providersError: string | null;
  signableProviders: PiLoginProvider[];
  allRows: PiProviderRow[];
  connectedRows: PiProviderRow[];
  popularRows: PiProviderRow[];
  searchedRows: PiProviderRow[];
  localRows: PiProviderRow[];
  runtimeConnections: AiRuntimeConnections;
  providerSearch: string;
  onProviderSearchChange: (value: string) => void;
  loadingProviders: boolean;
  /** Re-probes the local servers; the Pi login list alone says nothing here. */
  onRefreshDetection: () => void;
  onOpenProvider: (providerId: string) => void;
}) {
  return (
        <>
          {/* Named groups: the OpenCode section below carries the same visible
              labels, so assistive tech needs the harness in the name. */}
          <div role="group" aria-label="Connected Pi providers" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={SECTION_LABEL_STYLE}>Connected</div>
            {connectedRows.length ? (
              <ProviderGrid>
                {connectedRows.map((row) => (
                  <PiProviderCard key={row.id} provider={row} onOpen={() => onOpenProvider(row.id)} />
                ))}
              </ProviderGrid>
            ) : (
              <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                No providers connected yet. Pick one below to sign in or add a key.
              </div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={SECTION_LABEL_STYLE}>All providers · {allRows.length}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <ProviderSearchField
                label="Search all Pi providers"
                value={providerSearch}
                onChange={onProviderSearchChange}
              />
              {!providerSearch.trim() ? (
                <>
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>Popular</div>
                  <ProviderGrid>
                    {popularRows.map((row) => (
                      <PiProviderCard key={row.id} provider={row} onOpen={() => onOpenProvider(row.id)} />
                    ))}
                  </ProviderGrid>
                </>
              ) : searchedRows.length ? (
                <ProviderGrid>
                  {searchedRows.map((row) => (
                    <PiProviderCard key={row.id} provider={row} onOpen={() => onOpenProvider(row.id)} />
                  ))}
                </ProviderGrid>
              ) : (
                <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                  No providers match your search.
                </div>
              )}
            </div>
          </div>

          {localRows.length ? (
            <div role="group" aria-label="Pi local model servers" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div style={SECTION_LABEL_STYLE}>Local Model Servers</div>
                <button
                  type="button"
                  style={outlineButton({ height: 26, padding: "0 10px", fontSize: 11 })}
                  disabled={loadingProviders}
                  onClick={onRefreshDetection}
                >
                  <ArrowsClockwise size={11} weight="bold" /> {loadingProviders ? "Checking..." : "Refresh"}
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 8 }}>
                {localRows.map((row) => (
                  <PiLocalServerCard key={row.id} provider={row} connection={runtimeConnectionForPiProvider(runtimeConnections, row.id)} />
                ))}
              </div>
            </div>
          ) : null}

          {providers !== null && !signableProviders.length && !providersError ? (
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
              {allRows.length
                ? "These read their keys from the environment — there is nothing to sign in to here."
                : "No providers are set up in Pi yet."}
            </div>
          ) : null}
        </>
  );
}

/**
 * The card a running sign-in owns: Pi's progress, the device code and auth
 * URL, whatever prompt Pi is blocked on, and the settled outcome.
 *
 * The live region stays mounted across settles — `role` alone carries the
 * urgency, and adding `aria-live` would demote `alert` to polite.
 */
function PiSignInFlowCard({
  flow,
  outcome,
  providerName,
  promptValue,
  onPromptValueChange,
  promptFieldId,
  promptLabelId,
  promptInputRef,
  firstChoiceRef,
  retryButtonRef,
  onAnswer,
  onCancel,
  onRetry,
}: {
  flow: PiSignInFlow | null;
  outcome: PiSignInOutcome | null;
  providerName: (providerId: string) => string;
  promptValue: string;
  onPromptValueChange: (value: string) => void;
  promptFieldId: string;
  promptLabelId: string;
  promptInputRef: React.MutableRefObject<HTMLInputElement | null>;
  firstChoiceRef: React.MutableRefObject<HTMLButtonElement | null>;
  retryButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
  onAnswer: (value: string) => void;
  onCancel: () => void;
  onRetry: (outcome: PiSignInOutcome) => void;
}) {
  const { copy, copied } = useCopyToClipboard();
  const prompt = flow?.prompt ?? null;
  const choiceOptions = piChoiceOptions(prompt);
  const link = flow?.link ?? null;
  const userCode = link?.userCode ?? null;
  const verifyUrl = link?.url ?? link?.verificationUri ?? null;

  return (
    <>
      {flow ? (
        <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.cardBg, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.textPrimary }}>
            Signing in to {providerName(flow.providerId)}
          </div>
          <div role="status" aria-live="polite" style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
            {flow.progress ?? "Waiting for Pi…"}
          </div>

          {userCode ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>Code</span>
              <code style={{ fontSize: 16, fontFamily: MONO_FONT, letterSpacing: "2px", color: COLORS.textPrimary, background: `${COLORS.textDim}12`, border: `1px solid ${COLORS.border}`, padding: "4px 10px" }}>
                {userCode}
              </code>
              <button type="button" style={outlineButton({ height: 26 })} onClick={() => void copy(userCode)}>
                {copied ? "Copied" : "Copy code"}
              </button>
            </div>
          ) : null}

          {verifyUrl ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <code style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, overflowWrap: "anywhere", wordBreak: "break-all", minWidth: 0 }}>
                {verifyUrl}
              </code>
              <button type="button" style={outlineButton({ height: 26 })} onClick={() => openExternalUrl(verifyUrl)}>
                Open
              </button>
            </div>
          ) : null}

          {prompt ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {/* A label may only point at a form control, so the choice
                  branch names its button group instead of borrowing htmlFor. */}
              <label
                id={promptLabelId}
                {...(choiceOptions.length ? {} : { htmlFor: promptFieldId })}
                style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, lineHeight: 1.5 }}
              >
                {prompt.message}
              </label>
              {choiceOptions.length ? (
                <div role="group" aria-labelledby={promptLabelId} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {choiceOptions.map((option, index) => (
                    <button
                      key={option.value}
                      ref={index === 0 ? firstChoiceRef : undefined}
                      type="button"
                      style={outlineButton({ height: "auto", minHeight: 28, padding: "6px 10px", flexDirection: "column", alignItems: "flex-start", justifyContent: "center", gap: 2, textAlign: "left" })}
                      onClick={() => onAnswer(option.value)}
                    >
                      <span>{option.label}</span>
                      {option.description ? (
                        <span style={{ fontSize: 10, fontFamily: MONO_FONT, fontWeight: 400, color: COLORS.textDim }}>
                          {option.description}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : (
                <form
                  style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    onAnswer(promptValue);
                  }}
                >
                  <input
                    id={promptFieldId}
                    ref={promptInputRef}
                    type={prompt.kind === "secret" ? "password" : "text"}
                    value={promptValue}
                    placeholder={prompt.placeholder}
                    autoComplete="off"
                    onChange={(event) => onPromptValueChange(event.target.value)}
                    style={{ flex: "1 1 220px", minWidth: 0, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: "6px 8px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }}
                  />
                  <button type="submit" style={primaryButton({ height: 28 })} disabled={!promptValue.trim()}>
                    Continue
                  </button>
                </form>
              )}
            </div>
          ) : null}

          <div>
            <button type="button" style={outlineButton({ height: 26 })} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      ) : null}

      {/* The live region stays mounted across settles: a status/alert node
          inserted at the same instant its text appears is announced
          unreliably. Empty, it leaves the flow so it adds no column gap. The
          role alone carries urgency — an explicit aria-live would demote an
          alert back to polite. */}
      <div
        role={outcome?.state === "error" ? "alert" : "status"}
        style={
          outcome
            ? {
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                fontSize: 10,
                fontFamily: MONO_FONT,
                lineHeight: 1.5,
                color: outcome.state === "ok" ? COLORS.success : outcome.state === "cancelled" ? COLORS.textMuted : COLORS.danger,
              }
            : { position: "absolute", width: 0, height: 0, overflow: "hidden" }
        }
      >
        {outcome ? (
          <span>
            {outcome.state === "ok"
              ? `Signed in to ${providerName(outcome.providerId)}.`
              : outcome.state === "cancelled"
                ? "Sign-in cancelled."
                : `${providerName(outcome.providerId)}: ${outcome.error ?? "Sign-in did not finish."}`}
          </span>
        ) : null}
        {outcome?.state === "error" ? (
          <button
            ref={retryButtonRef}
            type="button"
            style={outlineButton({ height: 24, fontSize: 11 })}
            onClick={() => onRetry(outcome)}
          >
            Try again
          </button>
        ) : null}
      </div>
    </>
  );
}

export function PiProvidersPanel({
  installation,
  runtimeConnections,
  onSignedIn,
  onRefreshStatus,
}: {
  installation: AiPiInstallationStatus;
  /** ADE's own local-server probe, shared with the OpenCode section. */
  runtimeConnections: AiRuntimeConnections;
  onSignedIn: () => void;
  /** Re-runs the AI status probe that feeds `installation` and `runtimeConnections`. */
  onRefreshStatus: () => void;
}) {
  const [providers, setProviders] = useState<PiLoginProvider[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [flow, setFlow] = useState<PiSignInFlow | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [outcome, setOutcome] = useState<PiSignInOutcome | null>(null);
  const [providerSearch, setProviderSearch] = useState("");
  const [detailProviderId, setDetailProviderId] = useState<string | null>(null);
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  const firstChoiceRef = useRef<HTMLButtonElement | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  /** Pi reports a cancel as a plain failure, so remember that the user asked for it. */
  const cancelledProviderRef = useRef<string | null>(null);
  /** Providers whose latest attempt has already been reported. See `settle`. */
  const settledProvidersRef = useRef<Set<string>>(new Set());
  const lastPromptRequestIdRef = useRef<string | null>(null);
  const piSignInAttemptCounter = useRef(0);
  const promptFieldId = React.useId();
  const promptLabelId = `${promptFieldId}-label`;

  const loadProviders = useCallback(async () => {
    setLoadingProviders(true);
    try {
      const listed = await window.ade.ai.piLoginProviders();
      setProviders(listed);
      setProvidersError(null);
    } catch (err) {
      setProvidersError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingProviders(false);
    }
  }, []);

  useEffect(() => {
    if (!installation.sdkAvailable) return;
    void loadProviders();
  }, [installation.sdkAvailable, loadProviders]);

  // The status subscription is installed once, so the callbacks it needs are
  // read through refs rather than baked into a stale closure.
  const onSignedInRef = useRef(onSignedIn);
  const loadProvidersRef = useRef(loadProviders);
  const flowRef = useRef<PiSignInFlow | null>(null);
  const settleRef = useRef<(providerId: string, ok: boolean, error: string | null) => void>(() => undefined);
  useEffect(() => {
    onSignedInRef.current = onSignedIn;
    loadProvidersRef.current = loadProviders;
  }, [onSignedIn, loadProviders]);
  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);
  const openedAuthUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = window.ade.ai.onPiAuthStatus((event) => {
      // A sign-in settles in the main process, so its outcome is reported by
      // this event rather than only by whoever happens to still be awaiting
      // the start call. Settings is destroyed by any navigation, and binding
      // the result to that one promise is what left a completed browser
      // sign-in showing nothing in ADE.
      if (event.state === "success" || event.state === "error") {
        settleRef.current(event.providerId, event.state === "success", event.error ?? null);
        return;
      }
      setFlow((current) => {
        // Leaving Settings no longer cancels a login, so a flow can outlive its
        // card. Re-adopt it on the next event, or the prompt is undeliverable
        // and there is no Cancel until the ten-minute bound expires.
        if (!current && (event.state === "prompt" || event.state === "pending")) {
          return {
            attemptId: ++piSignInAttemptCounter.current,
            providerId: event.providerId,
            method: null,
            prompt: event.state === "prompt" ? event.prompt ?? null : null,
            link: event.notice?.url || event.notice?.userCode ? event.notice ?? null : null,
            progress: event.notice?.message ?? null,
          };
        }
        if (!current || current.providerId !== event.providerId) return current;
        if (event.state === "prompt" && event.prompt) return { ...current, prompt: event.prompt };
        if (event.state !== "pending" || !event.notice) return current;
        // A URL or device code is the step the user has to act on, so it stays
        // on screen; plain progress lines replace each other.
        return event.notice.url || event.notice.userCode
          ? { ...current, link: event.notice, progress: null }
          : { ...current, progress: event.notice.message };
      });
      // A local runtime delivers each status twice (direct IPC broadcast plus
      // the buffered relay), and the second copy can land after the user has
      // started typing. Only a genuinely new prompt clears the field, or the
      // duplicate would erase a half-entered API key.
      if (event.state === "prompt" && event.prompt) {
        setPromptValue((current) => (lastPromptRequestIdRef.current === event.prompt!.requestId ? current : ""));
        lastPromptRequestIdRef.current = event.prompt.requestId;
      }
    });
    return unsubscribe;
  }, []);

  // A device-code or OAuth step cannot proceed until the page is open, and Pi
  // is already polling by the time the URL arrives. Open it once per URL and
  // leave the copyable URL and code on screen for a blocked or wrong browser.
  useEffect(() => {
    const url = flow?.link?.url ?? flow?.link?.verificationUri ?? null;
    if (!url || openedAuthUrlRef.current === url) return;
    openedAuthUrlRef.current = url;
    openExternalUrl(url);
  }, [flow?.link?.url, flow?.link?.verificationUri]);

  useEffect(() => {
    if (!flow?.prompt) return;
    // A choice prompt unmounts whatever held focus, so hand focus to the first
    // option rather than letting it fall back to the document.
    if (piChoiceOptions(flow.prompt).length) firstChoiceRef.current?.focus();
    else promptInputRef.current?.focus();
  }, [flow?.prompt]);

  useEffect(() => {
    // Settling unmounts the flow card, which is where focus was; without this a
    // keyboard user lands back on the document body instead of the one control
    // that can recover the failed attempt.
    if (outcome?.state === "error") retryButtonRef.current?.focus();
  }, [outcome]);

  /**
   * Report a finished sign-in exactly once.
   *
   * `finish()` in the main process emits the status event and resolves the
   * start call from the same place, and their arrival order at the renderer is
   * not fixed. Both channels are kept — the event survives a remount, the
   * resolution survives a dropped push — so the first one to land settles and
   * the other is a no-op. Without the latch the provider list refreshed twice
   * and the "was this a user cancel" ref could be cleared before the slower
   * channel read it.
   */
  const settle = useCallback((providerId: string, ok: boolean, error: string | null) => {
    if (settledProvidersRef.current.has(providerId)) return;
    settledProvidersRef.current.add(providerId);
    const cancelled = !ok && cancelledProviderRef.current === providerId;
    setOutcome({
      providerId,
      method: flowRef.current?.providerId === providerId ? flowRef.current.method : null,
      state: ok ? "ok" : cancelled ? "cancelled" : "error",
      ...(ok || cancelled || !error ? {} : { error }),
    });
    setFlow((current) => (current?.providerId === providerId ? null : current));
    if (ok) {
      onSignedInRef.current();
      void loadProvidersRef.current();
    }
  }, []);
  useEffect(() => {
    settleRef.current = settle;
  }, [settle]);

  const start = async (providerId: string, method?: PiLoginMethod) => {
    setOutcome(null);
    setPromptValue("");
    cancelledProviderRef.current = null;
    settledProvidersRef.current.delete(providerId);
    // A retry usually re-issues the same auth URL, and it still has to open.
    openedAuthUrlRef.current = null;
    const attemptId = ++piSignInAttemptCounter.current;
    setFlow({ attemptId, providerId, method: method ?? null, prompt: null, link: null, progress: null });
    // Every update below runs after an await, by which time "Try again" may have
    // started a replacement. A superseded attempt must not report its own
    // outcome or refresh providers on the newer one's behalf.
    const isCurrentAttempt = () => piSignInAttemptCounter.current === attemptId;
    try {
      const result = await window.ade.ai.piLoginStart({ providerId, ...(method ? { method } : {}) });
      if (!isCurrentAttempt()) return;
      settle(providerId, result.ok, result.error ?? null);
    } catch (err) {
      if (!isCurrentAttempt()) return;
      // The call itself failed, which the status stream would never report.
      settle(providerId, false, err instanceof Error ? err.message : String(err));
    } finally {
      // A second sign-in may already own these, so only this attempt's own
      // state is torn down here.
      if (cancelledProviderRef.current === providerId) cancelledProviderRef.current = null;
      setFlow((current) => (current?.attemptId === attemptId ? null : current));
    }
  };

  const answer = async (value: string) => {
    const prompt = flow?.prompt;
    if (!flow || !prompt) return;
    setFlow((current) => (current ? { ...current, prompt: null } : current));
    setPromptValue("");
    const fail = (error: string) =>
      setOutcome({ providerId: flow.providerId, method: flow.method, state: "error", error });
    try {
      // A rejected answer comes back as ok:false rather than a throw, and the
      // prompt is already gone — without this the user waits out Pi's login
      // timeout with nothing on screen.
      const result = await window.ade.ai.piLoginSubmit({
        providerId: flow.providerId,
        requestId: prompt.requestId,
        value,
      });
      if (!result.ok) fail(result.error ?? "Pi did not accept that answer.");
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  };

  const cancel = () => {
    if (!flow) return;
    cancelledProviderRef.current = flow.providerId;
    void window.ade.ai.piLoginCancel({ providerId: flow.providerId }).catch(() => undefined);
  };

  const signableProviders = providers ?? [];
  const providerName = (providerId: string) =>
    signableProviders.find((provider) => provider.id === providerId)?.name
    ?? installation.providers.find((provider) => provider.id === providerId)?.name
    ?? providerId;
  // Every provider Pi knows about: the ones already configured in the profile
  // and the ones ADE can sign into, merged by id so one provider is one card.
  const allRows = buildPiProviderRows(
    installation.providers.filter((provider) => provider.configured),
    signableProviders,
  );
  // A loopback server has nothing to sign into, so its login options are
  // dropped rather than merely hidden — that is what put an API key prompt in
  // front of LM Studio.
  const localRows = allRows
    .filter((row) => row.status?.authType === "local")
    .map((row) => ({ ...row, login: null }));
  const signableOrKeyedRows = allRows.filter((row) => row.status?.authType !== "local");
  const connectedRows = signableOrKeyedRows.filter(piProviderIsConnected);
  const search = providerSearch.trim().toLowerCase();
  // Local servers have their own section and no sign-in, so they must not
  // reappear here as a card that opens the sign-in dialog.
  const searchedRows = search
    ? signableOrKeyedRows.filter((row) => row.id.toLowerCase().includes(search) || row.name.toLowerCase().includes(search))
    : [];
  // "Popular" is what is worth showing before the user searches: everything
  // with an interactive sign-in, most models first, minus what is already
  // pinned above.
  const popularRows = signableOrKeyedRows
    .filter((row) => !piProviderIsConnected(row) && (row.login?.authTypes.length ?? 0) > 0)
    .sort((left, right) => (piProviderModelCount(right) ?? 0) - (piProviderModelCount(left) ?? 0));
  const modelIdsByProvider = new Map<string, string[]>();
  for (const registryId of installation.availableModelIds) {
    const decoded = decodePiRegistryId(registryId);
    if (!decoded) continue;
    const existing = modelIdsByProvider.get(decoded.providerId);
    if (existing) existing.push(decoded.modelId);
    else modelIdsByProvider.set(decoded.providerId, [decoded.modelId]);
  }
  const detailProvider = detailProviderId
    ? allRows.find((row) => row.id === detailProviderId) ?? null
    : null;
  if (!installation.sdkAvailable) {
    return (
      // The card's own message already states the blocker, so this branch only
      // has to offer the way out.
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>Sign in</div>
        <PiTerminalFallback installation={installation} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>Providers</div>
        <button type="button" style={outlineButton({ height: 26 })} disabled={loadingProviders} onClick={() => void loadProviders()}>
          {loadingProviders ? "Loading…" : "Refresh providers"}
        </button>
      </div>

      {providersError ? (
        <div role="alert" style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.danger }}>
          Could not list Pi providers: {providersError}
        </div>
      ) : null}

      <PiSignInFlowCard
        flow={flow}
        outcome={outcome}
        providerName={providerName}
        promptValue={promptValue}
        onPromptValueChange={setPromptValue}
        promptFieldId={promptFieldId}
        promptLabelId={promptLabelId}
        promptInputRef={promptInputRef}
        firstChoiceRef={firstChoiceRef}
        retryButtonRef={retryButtonRef}
        onAnswer={(value) => void answer(value)}
        onCancel={cancel}
        onRetry={(settled) => void start(settled.providerId, settled.method ?? undefined)}
      />

      {/* Starting a second sign-in cancels the first, so the list steps aside
          while one is running. */}
      {!flow ? (
        <PiProviderBrowser
          providers={providers}
          providersError={providersError}
          signableProviders={signableProviders}
          allRows={allRows}
          connectedRows={connectedRows}
          popularRows={popularRows}
          searchedRows={searchedRows}
          localRows={localRows}
          runtimeConnections={runtimeConnections}
          providerSearch={providerSearch}
          onProviderSearchChange={setProviderSearch}
          loadingProviders={loadingProviders}
          onRefreshDetection={() => {
            void loadProviders();
            onRefreshStatus();
          }}
          onOpenProvider={setDetailProviderId}
        />
      ) : null}
      {detailProvider ? (
        <PiProviderDetailModal
          provider={detailProvider}
          modelIds={modelIdsByProvider.get(detailProvider.id) ?? []}
          onStartSignIn={(providerId, method) => {
            setDetailProviderId(null);
            void start(providerId, method);
          }}
          onClose={() => setDetailProviderId(null)}
        />
      ) : null}

    </div>
  );
}
