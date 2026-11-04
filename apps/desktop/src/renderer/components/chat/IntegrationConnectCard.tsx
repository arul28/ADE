import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowSquareOut, Check, CheckCircle, Copy, Eye, EyeSlash, GearSix, LockKey, Prohibit, SpinnerGap, Warning, X } from "@phosphor-icons/react";
import type { PendingInputRequest } from "../../../shared/types";
import {
  CONNECT_METHOD_QUESTION_ID,
  connectMethod,
  connectProviderSpec,
  integrationConnectAnswers,
  isSelfRunConnectMethod,
  type ConnectField,
  type ConnectMethod,
  type ConnectMethodId,
  type IntegrationConnectRequestCard,
} from "../../../shared/integrationConnect";
import { ownQuestionValue } from "../../../shared/pendingInputAnswers";
import { cardAskerFamily, providerDisplayName } from "../../../shared/pendingInputLabels";
import { deviceAuthErrorCopy, deviceAuthMessageCopy } from "../../lib/githubIntegrationStatus";
import { navigateToAppTarget } from "../../lib/openExternal";
import { isImeComposing } from "../../lib/imeComposition";
import { useAppStore } from "../../state/appStore";
import { integrationBrand, integrationThemeVars } from "../settings/integrations/integrationBrand";
import { SolidLogo } from "../settings/providers/ProviderHero";
import { ProviderLogo } from "../shared/ProviderLogos";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { chatSettingsMachineId } from "./chatDeeplinks";
import { ChatCard, ChatCardRow, ChatCardTitle } from "./chatCardPrimitives";
import "../settings/providers/providerPage.css";
import "./integrationConnectCard.css";

/**
 * The connect card.
 *
 * An agent runs `ade integrations connect <provider> --reason …`. The card
 * takes the composer's place, the way the private secret card does, wearing
 * the integration's own banner and 3D logo from its Settings page. The person
 * picks a way to connect on one row: a browser or device sign-in where the
 * provider has one, or the key fields. Keys go back only as answers to `isSecret` questions; the
 * host on the chat's machine checks them with the provider and saves them
 * into the integration before the card closes. A refused key keeps the card
 * open with the provider's reason.
 *
 * A sign-in runs here, against the chat's machine, and answers with the
 * method alone; the host checks the integration really is connected.
 */

const LINEAR_OAUTH_POLL_MS = 1_500;
const LINEAR_OAUTH_TIMEOUT_MS = 5 * 60_000;

function openUrl(url: string): void {
  void window.ade?.app?.openExternal?.(url);
}

/**
 * Whether a browser sign-in can finish where this chat runs. The sign-in
 * comes back to a port on the chat's machine, so it works only when that is
 * the computer in front of the person.
 */
function useChatRunsHere(): boolean {
  const pin = useChatRuntimeScope().pin;
  const tabRemote = useAppStore((state) => state.projectBinding?.kind === "remote");
  return pin ? pin.kind !== "remote" : !tabRemote;
}

type OAuthState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting"; sessionId: string }
  | { phase: "done" };

/**
 * Linear's browser sign-in, against the chat's machine. Polls only while a
 * sign-in is open, and stops on its own after five minutes.
 */
function useLinearOAuth(onSignedIn: () => void): {
  state: OAuthState;
  error: string | null;
  start: () => void;
  cancel: () => void;
} {
  const pin = useChatRuntimeScope().pin;
  const [state, setState] = useState<OAuthState>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  const start = useCallback(() => {
    const cto = window.ade?.cto;
    if (!cto || !window.ade?.app?.openExternal) {
      setError("Browser sign-in is not available in this ADE build. Use an API key.");
      return;
    }
    setError(null);
    setState({ phase: "starting" });
    void (async () => {
      try {
        const session = await cto.startLinearOAuth(pin);
        await window.ade.app.openExternal(session.authUrl);
        setState({ phase: "waiting", sessionId: session.sessionId });
      } catch (startError) {
        setState({ phase: "idle" });
        setError(startError instanceof Error ? startError.message : "Could not start the sign-in.");
      }
    })();
    // A rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key]);

  const cancel = useCallback(() => setState({ phase: "idle" }), []);

  const sessionId = state.phase === "waiting" ? state.sessionId : null;
  useEffect(() => {
    const cto = window.ade?.cto;
    if (!sessionId || !cto) return;
    let active = true;
    const poll = async () => {
      try {
        const session = await cto.getLinearOAuthSession({ sessionId }, pin);
        if (!active) return;
        if (session.status === "completed") {
          active = false;
          setState({ phase: "done" });
          onSignedInRef.current();
        } else if (session.status === "failed" || session.status === "expired") {
          active = false;
          setState({ phase: "idle" });
          setError(session.error ?? "The sign-in did not finish. Try again.");
        }
      } catch (pollError) {
        if (!active) return;
        active = false;
        setState({ phase: "idle" });
        setError(pollError instanceof Error ? pollError.message : "The sign-in did not finish. Try again.");
      }
    };
    void poll();
    const timer = window.setInterval(() => { if (active) void poll(); }, LINEAR_OAUTH_POLL_MS);
    const timeout = window.setTimeout(() => {
      if (!active) return;
      active = false;
      setState({ phase: "idle" });
      setError("The sign-in timed out. Try again.");
    }, LINEAR_OAUTH_TIMEOUT_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, pin?.key]);

  return { state, error, start, cancel };
}

type DeviceState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting"; sessionId: string; code: string; url: string; intervalMs: number }
  | { phase: "done" };

/**
 * GitHub's device sign-in for ADE's app, against the chat's machine. The code
 * is typed on github.com from any computer, so it also works for a chat that
 * runs on another machine. Polls only while a code is open.
 */
function useGithubDeviceSignIn(onSignedIn: () => void): {
  state: DeviceState;
  error: string | null;
  start: () => void;
  cancel: () => void;
} {
  const pin = useChatRuntimeScope().pin;
  const [state, setState] = useState<DeviceState>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  const start = useCallback(() => {
    const github = window.ade?.github;
    if (!github?.startAppUserDeviceAuth) {
      setError("ADE app sign-in is not available here. Use a token.");
      return;
    }
    setError(null);
    setState({ phase: "starting" });
    void (async () => {
      try {
        const session = await github.startAppUserDeviceAuth(pin);
        const url = session.verificationUriComplete ?? session.verificationUri;
        openUrl(url);
        setState({ phase: "waiting", sessionId: session.sessionId, code: session.userCode, url, intervalMs: Math.max(1, session.intervalSec) * 1000 });
      } catch (startError) {
        setState({ phase: "idle" });
        setError(deviceAuthErrorCopy(startError));
      }
    })();
    // A rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key]);

  const cancel = useCallback(() => setState({ phase: "idle" }), []);

  const sessionId = state.phase === "waiting" ? state.sessionId : null;
  const intervalMs = state.phase === "waiting" ? state.intervalMs : 0;
  useEffect(() => {
    const github = window.ade?.github;
    if (!sessionId || !github?.pollAppUserDeviceAuth) return;
    let active = true;
    let timer = 0;
    let delay = intervalMs;
    const poll = async () => {
      try {
        const result = await github.pollAppUserDeviceAuth({ sessionId }, pin);
        if (!active) return;
        if (result.status === "authorized") {
          active = false;
          setState({ phase: "done" });
          onSignedInRef.current();
          return;
        }
        if (result.status === "pending" || result.status === "slow_down") {
          delay = Math.max(delay, (result.intervalSec ?? 0) * 1000) + (result.status === "slow_down" ? 5_000 : 0);
          timer = window.setTimeout(() => void poll(), delay);
          return;
        }
        active = false;
        setState({ phase: "idle" });
        setError(result.status === "expired"
          ? "The code expired. Sign in again for a new one."
          : result.status === "denied"
            ? "GitHub says the sign-in was denied."
            : deviceAuthMessageCopy(result.message) ?? "The sign-in did not finish. Try again.");
      } catch (pollError) {
        if (!active) return;
        active = false;
        setState({ phase: "idle" });
        setError(deviceAuthErrorCopy(pollError));
      }
    };
    timer = window.setTimeout(() => void poll(), delay);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, intervalMs, pin?.key]);

  return { state, error, start, cancel };
}

function ConnectFieldInput({
  field,
  value,
  onChange,
  onSubmit,
  disabled,
  autoFocus,
}: {
  field: ConnectField;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  autoFocus: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const secret = field.kind === "secret";
  return (
    <span className="ade-icc-input" data-secret={secret ? "true" : undefined}>
      <input
        type={secret && !revealed ? "password" : field.kind === "email" ? "email" : "text"}
        aria-label={field.label}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete={secret ? "new-password" : field.kind === "email" ? "email" : "off"}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={field.placeholder}
        data-testid={`integration-connect-field-${field.id}`}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || isImeComposing(event)) return;
          event.preventDefault();
          onSubmit();
        }}
      />
      {secret ? (
        <button
          type="button"
          className="ade-icc-icon-button"
          disabled={disabled}
          aria-label={revealed ? "Hide" : "Show"}
          title={revealed ? "Hide" : "Show"}
          onClick={() => setRevealed((prev) => !prev)}
        >
          {revealed ? <EyeSlash size={13} /> : <Eye size={13} />}
        </button>
      ) : null}
    </span>
  );
}

/**
 * The agent-raised card, in the composer's place. Enter connects, Esc says
 * not now.
 */
export function IntegrationConnectComposer({
  request,
  card,
  responding,
  error,
  onConnect,
  onDecline,
  chatProvider,
}: {
  request: PendingInputRequest;
  card: IntegrationConnectRequestCard;
  responding: boolean;
  /** Why the last answer did not connect, from the host. */
  error: string | null;
  onConnect: (answers: Record<string, string>) => void;
  onDecline: () => void;
  /** The chat's provider: the agent that ran the command, which the card names. */
  chatProvider?: string | null;
}) {
  const spec = connectProviderSpec(card.provider);
  const brand = integrationBrand(card.provider);
  const scope = useChatRuntimeScope();
  const runsHere = useChatRunsHere();
  // The host offers what can still help (GitHub drops its app once reads
  // work). A browser sign-in cannot finish for a chat on another computer, so
  // it is left out there; the key methods stay.
  const methods = useMemo(
    () => spec.methods.filter((method) =>
      (!card.methods || card.methods.includes(method.id)) && (!method.browser || runsHere)),
    [card.methods, runsHere, spec.methods],
  );
  const [methodId, setMethodId] = useState<ConnectMethodId>(methods[0]!.id);
  const method: ConnectMethod = methods.find((candidate) => candidate.id === methodId) ?? methods[0]!;
  const [values, setValues] = useState<Record<string, string>>({});

  const signedInWith = useCallback((id: ConnectMethodId) => {
    onConnect(integrationConnectAnswers(id, {}));
  }, [onConnect]);
  const oauth = useLinearOAuth(useCallback(() => signedInWith("oauth"), [signedInWith]));
  const device = useGithubDeviceSignIn(useCallback(() => signedInWith("app"), [signedInWith]));
  const signingIn = oauth.state.phase === "starting" || oauth.state.phase === "waiting"
    || device.state.phase === "starting" || device.state.phase === "waiting";
  const busy = responding || signingIn || oauth.state.phase === "done" || device.state.phase === "done";

  const selfRun = isSelfRunConnectMethod(method);
  const filled = method.fields.every((field) => (values[field.id] ?? "").trim().length > 0);
  const canConnect = !busy && (selfRun || filled);

  const connect = useCallback(() => {
    if (!canConnect) return;
    if (method.browser) {
      oauth.start();
      return;
    }
    if (method.device) {
      device.start();
      return;
    }
    const answers: Record<string, string> = {};
    for (const field of method.fields) answers[field.id] = values[field.id] ?? "";
    onConnect(integrationConnectAnswers(method.id, answers));
  }, [canConnect, device, method, oauth, onConnect, values]);

  const cancelSignIn = useCallback(() => {
    oauth.cancel();
    device.cancel();
  }, [device, oauth]);

  const openSettings = useCallback(() => {
    navigateToAppTarget({ kind: "settings", entryId: spec.settingsSection, machineId: chatSettingsMachineId(scope) });
  }, [scope, spec.settingsSection]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (signingIn) cancelSignIn();
      else if (!responding) onDecline();
    }
  };

  const [codeCopied, setCodeCopied] = useState(false);
  const copyCode = useCallback((code: string) => {
    void navigator.clipboard?.writeText(code).then(() => setCodeCopied(true), () => {});
  }, []);

  const shownError = oauth.error ?? device.error ?? error;
  const askerFamily = cardAskerFamily(request.source, chatProvider);
  const asker = providerDisplayName(askerFamily);
  const savedTitle = `${card.savedNote ?? spec.savedWhere} Never shown to the agent.`;
  const waitingCode = device.state.phase === "waiting" ? device.state : null;

  return (
    <div
      role="group"
      aria-label={`${asker} asks to connect ${spec.label}`}
      data-testid="integration-connect-composer"
      data-provider={card.provider}
      className="ade-icc"
      data-light={brand.lightBanner ? "true" : undefined}
      style={integrationThemeVars(brand.accent)}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div className="ade-icc-banner" style={brand.banner}>
        <img className="ade-icc-banner-art" src={brand.art} alt="" draggable={false} />
        <div className="ade-icc-banner-shade" aria-hidden />
        <span className="ade-icc-logo"><SolidLogo spec={{ ...brand.logo, size: 30 }} straight /></span>
        <span className="ade-icc-heading">
          <span className="ade-icc-asker" title={asker}><ProviderLogo family={askerFamily} size={11} /></span>
          <span className="ade-icc-heading-text">
            <span className="ade-icc-heading-dim">{asker} asks to connect </span>
            <span className="ade-icc-title">{spec.label}</span>
          </span>
        </span>
        <span className="ade-icc-banner-tools">
          {card.current ? <span className="ade-icc-chip" data-testid="integration-connect-current">{card.current}</span> : null}
          {card.savedNote ? (
            <span className="ade-icc-chip" data-tone="warn" title={card.savedNote}>This computer only</span>
          ) : null}
          <button
            type="button"
            className="ade-icc-close"
            title="Open in Settings"
            aria-label="Open in Settings"
            data-testid="integration-connect-settings"
            onClick={openSettings}
          >
            <GearSix size={13} weight="bold" />
          </button>
          <button
            type="button"
            className="ade-icc-close"
            disabled={responding}
            title="Not now (Esc)"
            aria-label="Not now"
            data-testid="integration-connect-decline"
            onClick={onDecline}
          >
            <X size={13} weight="bold" />
          </button>
        </span>
      </div>

      <div className="ade-icc-body">
        {card.reason ? <p className="ade-icc-reason">{card.reason}</p> : null}

        <div className="ade-icc-row" data-fields={method.fields.length}>
          {methods.length > 1 ? (
            <span className="ade-icc-tabs" role="tablist" aria-label={`Ways to connect ${spec.label}`}>
              {methods.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  role="tab"
                  aria-selected={candidate.id === method.id}
                  className="ade-icc-tab"
                  disabled={busy}
                  title={candidate.hint}
                  data-testid={`integration-connect-method-${candidate.id}`}
                  onClick={() => setMethodId(candidate.id)}
                >
                  {candidate.label}
                </button>
              ))}
            </span>
          ) : null}

          {selfRun ? (
            waitingCode ? (
              <span className="ade-icc-code" data-testid="integration-connect-device-code">
                <button
                  type="button"
                  className="ade-icc-code-value"
                  title="Copy the code"
                  onClick={() => copyCode(waitingCode.code)}
                >
                  {waitingCode.code}
                  {codeCopied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
                </button>
                <button type="button" className="ade-icc-link" onClick={() => openUrl(waitingCode.url)}>
                  Enter it on GitHub
                  <ArrowSquareOut size={10} weight="bold" />
                </button>
                <SpinnerGap size={13} weight="bold" className="ade-icc-wait motion-safe:animate-spin" aria-label="Waiting for GitHub" />
                <button type="button" className="ade-icc-link ade-icc-link-dim" onClick={cancelSignIn}>Cancel</button>
              </span>
            ) : (
              <>
                <button
                  type="button"
                  className="ade-icc-primary ade-icc-primary-brand"
                  disabled={!canConnect}
                  autoFocus
                  data-testid={method.browser ? "integration-connect-oauth" : "integration-connect-device"}
                  onClick={connect}
                >
                  {busy ? (
                    <SpinnerGap size={14} weight="bold" className="motion-safe:animate-spin" />
                  ) : (
                    <span className="ade-icc-primary-mark" aria-hidden>{brand.logo.mark(14)}</span>
                  )}
                  {oauth.state.phase === "waiting"
                    ? "Waiting for the browser…"
                    : busy
                      ? "Checking…"
                      : `Continue with ${spec.label}`}
                </button>
                {oauth.state.phase === "waiting" ? (
                  <button type="button" className="ade-icc-link ade-icc-link-dim" onClick={cancelSignIn}>Cancel</button>
                ) : null}
              </>
            )
          ) : (
            <>
              <span className="ade-icc-fields" title={savedTitle}>
                {method.fields.map((field, index) => (
                  <ConnectFieldInput
                    key={field.id}
                    field={field}
                    value={values[field.id] ?? ""}
                    onChange={(next) => setValues((prev) => ({ ...prev, [field.id]: next }))}
                    onSubmit={connect}
                    disabled={busy}
                    autoFocus={index === 0}
                  />
                ))}
              </span>
              {method.help ? (
                <button type="button" className="ade-icc-link" onClick={() => openUrl(method.help!.url)}>
                  {method.help.label}
                  <ArrowSquareOut size={10} weight="bold" />
                </button>
              ) : null}
              <button
                type="button"
                className="ade-icc-primary"
                disabled={!canConnect}
                title={savedTitle}
                data-testid="integration-connect-submit"
                onClick={connect}
              >
                {responding ? <SpinnerGap size={13} weight="bold" className="motion-safe:animate-spin" /> : <LockKey size={12} weight="bold" />}
                {responding ? "Checking…" : "Connect"}
              </button>
            </>
          )}
        </div>

        {shownError ? (
          <div className="ade-icc-error" role="alert" data-testid="integration-connect-error">
            <Warning size={13} weight="fill" />
            <span>{shownError}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const METHOD_RECEIPT: Record<ConnectMethodId, string> = {
  oauth: "through the browser",
  api_key: "with an API key",
  token: "with an access token",
  site_token: "with an API token",
  app: "with the ADE app",
};

/**
 * The transcript record: one line while the card waits, then the receipt.
 * Built from the provider and the method alone; no key ever reached the event.
 */
export function IntegrationConnectReceipt({
  card,
  resolution,
  answers,
}: {
  card: IntegrationConnectRequestCard;
  resolution: "accepted" | "declined" | "cancelled" | null;
  answers?: Record<string, string | string[]> | undefined;
}) {
  const spec = connectProviderSpec(card.provider);
  const brand = integrationBrand(card.provider);
  const logo = (
    <span className="ade-icc-receipt-logo" style={brand.banner} data-light={brand.lightBanner ? "true" : undefined} aria-hidden>
      <span style={{ color: brand.logo.face }}>{brand.logo.mark(11)}</span>
    </span>
  );
  if (resolution === null) {
    return (
      <ChatCard skin="line" data-testid="integration-connect-receipt-open">
        <ChatCardRow tone="running" meta="awaiting you">
          <ChatCardTitle>
            <span className="inline-flex items-center gap-1.5 align-middle">
              {logo}
              <span><span className="font-normal text-fg/55">Connect </span>{spec.label}</span>
            </span>
          </ChatCardTitle>
        </ChatCardRow>
      </ChatCard>
    );
  }
  const raw = ownQuestionValue(answers, CONNECT_METHOD_QUESTION_ID);
  const methodAnswer = Array.isArray(raw) ? raw[0] : raw;
  const method = connectMethod(card.provider, methodAnswer ?? null);
  const accepted = resolution === "accepted";
  const text = accepted
    ? `connected${method ? ` ${METHOD_RECEIPT[method.id]}` : ""} · never shown to the agent`
    : resolution === "declined" ? "· not now" : "· closed before it was answered";
  return (
    <ChatCard skin="line" data-testid="integration-connect-receipt">
      <ChatCardRow tone={accepted ? "ok" : "idle"} icon={accepted ? CheckCircle : Prohibit}>
        <ChatCardTitle>
          <span className="inline-flex items-center gap-1.5 align-middle">
            {logo}
            <span>{spec.label}<span className="font-normal text-fg/55"> {text}</span></span>
          </span>
        </ChatCardTitle>
      </ChatCardRow>
    </ChatCard>
  );
}

