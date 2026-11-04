import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowSquareOut, CheckCircle, Eye, EyeSlash, GearSix, LockKey, Prohibit, SpinnerGap, Warning, X } from "@phosphor-icons/react";
import type { PendingInputRequest } from "../../../shared/types";
import {
  CONNECT_METHOD_QUESTION_ID,
  connectMethod,
  connectProviderSpec,
  integrationConnectAnswers,
  type ConnectField,
  type ConnectMethod,
  type ConnectMethodId,
  type IntegrationConnectRequestCard,
} from "../../../shared/integrationConnect";
import { ownQuestionValue } from "../../../shared/pendingInputAnswers";
import { cardAskerFamily, providerDisplayName } from "../../../shared/pendingInputLabels";
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
 * picks a way to connect: a browser sign-in where the provider has one, or
 * the key fields. Keys go back only as answers to `isSecret` questions; the
 * host on the chat's machine checks them with the provider and saves them
 * into the integration before the card closes. A refused key keeps the card
 * open with the provider's reason.
 *
 * A browser sign-in runs here, on the chat's machine, and answers with the
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

function ConnectFieldInput({
  field,
  value,
  onChange,
  onSubmit,
  disabled,
  autoFocus,
  hideLabel,
}: {
  field: ConnectField;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  autoFocus: boolean;
  /** The method's tab already names a lone field. */
  hideLabel: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const secret = field.kind === "secret";
  return (
    <label className="ade-icc-field" data-secret={secret ? "true" : undefined}>
      {hideLabel ? null : <span className="ade-icc-field-label">{field.label}</span>}
      <span className="ade-icc-input">
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
    </label>
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
  // A browser sign-in cannot finish for a chat on another computer: it is
  // left out there, and the key methods stay.
  const methods = useMemo(
    () => spec.methods.filter((method) => !method.browser || runsHere),
    [runsHere, spec.methods],
  );
  const browserHidden = methods.length < spec.methods.length;
  const [methodId, setMethodId] = useState<ConnectMethodId>(methods[0]!.id);
  const method: ConnectMethod = methods.find((candidate) => candidate.id === methodId) ?? methods[0]!;
  const [values, setValues] = useState<Record<string, string>>({});

  const connectWithBrowser = useCallback(() => {
    onConnect(integrationConnectAnswers("oauth", {}));
  }, [onConnect]);
  const oauth = useLinearOAuth(connectWithBrowser);
  const signingIn = oauth.state.phase === "starting" || oauth.state.phase === "waiting";
  const busy = responding || signingIn || oauth.state.phase === "done";

  const filled = method.fields.every((field) => (values[field.id] ?? "").trim().length > 0);
  const canConnect = !busy && (method.browser ? true : filled);

  const connect = useCallback(() => {
    if (!canConnect) return;
    if (method.browser) {
      oauth.start();
      return;
    }
    const answers: Record<string, string> = {};
    for (const field of method.fields) answers[field.id] = values[field.id] ?? "";
    onConnect(integrationConnectAnswers(method.id, answers));
  }, [canConnect, method, oauth, onConnect, values]);

  const openSettings = useCallback(() => {
    navigateToAppTarget({ kind: "settings", entryId: spec.settingsSection, machineId: chatSettingsMachineId(scope) });
  }, [scope, spec.settingsSection]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (signingIn) oauth.cancel();
      else if (!responding) onDecline();
    }
  };

  const shownError = oauth.error ?? error;
  const askerFamily = cardAskerFamily(request.source, chatProvider);
  const asker = providerDisplayName(askerFamily);

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
        <span className="ade-icc-watermark" aria-hidden>{brand.logo.mark(150)}</span>
        <div className="ade-icc-banner-shade" aria-hidden />
        <span className="ade-icc-logo"><SolidLogo spec={{ ...brand.logo, size: 40 }} straight /></span>
        <div className="ade-icc-banner-id">
          <span className="ade-icc-eyebrow">
            <span className="ade-icc-asker"><ProviderLogo family={askerFamily} size={11} /></span>
            {asker} asks to connect
          </span>
          <span className="ade-icc-title">{spec.label}</span>
        </div>
        <button
          type="button"
          className="ade-icc-close"
          disabled={responding}
          title="Not now (Esc)"
          aria-label="Not now"
          data-testid="integration-connect-decline-x"
          onClick={onDecline}
        >
          <X size={13} weight="bold" />
        </button>
      </div>

      <div className="ade-icc-body">
        {card.reason ? <p className="ade-icc-reason">{card.reason}</p> : null}

        {methods.length > 1 ? (
          <div className="ade-icc-tabs" role="tablist" aria-label={`Ways to connect ${spec.label}`}>
            {methods.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={candidate.id === method.id}
                className="ade-icc-tab"
                disabled={busy}
                data-testid={`integration-connect-method-${candidate.id}`}
                onClick={() => setMethodId(candidate.id)}
              >
                {candidate.label}
              </button>
            ))}
          </div>
        ) : null}

        {method.browser ? (
          <div className="ade-icc-browser">
            <button
              type="button"
              className="ade-icc-primary ade-icc-primary-wide"
              disabled={!canConnect}
              autoFocus
              data-testid="integration-connect-oauth"
              onClick={connect}
            >
              {signingIn || oauth.state.phase === "done" || responding ? (
                <SpinnerGap size={14} weight="bold" className="motion-safe:animate-spin" />
              ) : (
                <span className="ade-icc-primary-mark" aria-hidden>{brand.logo.mark(14)}</span>
              )}
              {oauth.state.phase === "waiting"
                ? "Waiting for you in the browser…"
                : oauth.state.phase === "done" || responding
                  ? "Checking…"
                  : `Continue with ${spec.label}`}
            </button>
            <div className="ade-icc-hint">
              {oauth.state.phase === "waiting" ? (
                <>
                  Approve ADE in the tab that opened.{" "}
                  <button type="button" className="ade-icc-link" onClick={oauth.cancel}>Cancel</button>
                </>
              ) : method.hint}
            </div>
          </div>
        ) : (
          <div className="ade-icc-form" data-fields={method.fields.length}>
            <div className="ade-icc-fields">
              {method.fields.map((field, index) => (
                <ConnectFieldInput
                  key={field.id}
                  field={field}
                  value={values[field.id] ?? ""}
                  onChange={(next) => setValues((prev) => ({ ...prev, [field.id]: next }))}
                  onSubmit={connect}
                  disabled={busy}
                  autoFocus={index === 0}
                  hideLabel={methods.length > 1 && method.fields.length === 1}
                />
              ))}
            </div>
            <div className="ade-icc-form-row">
              <div className="ade-icc-hint">
                {method.hint}
                {method.help ? (
                  <>
                    {" "}
                    <button type="button" className="ade-icc-link" onClick={() => openUrl(method.help!.url)}>
                      {method.help.label}
                      <ArrowSquareOut size={10} weight="bold" />
                    </button>
                  </>
                ) : null}
              </div>
              <button
                type="button"
                className="ade-icc-primary"
                disabled={!canConnect}
                data-testid="integration-connect-submit"
                onClick={connect}
              >
                {responding ? <SpinnerGap size={13} weight="bold" className="motion-safe:animate-spin" /> : null}
                {responding ? "Checking…" : "Connect"}
              </button>
            </div>
          </div>
        )}

        {browserHidden && !method.browser ? (
          <div className="ade-icc-note">
            This chat runs on another computer, so browser sign-in is off here. A key works from anywhere.
          </div>
        ) : null}

        {shownError ? (
          <div className="ade-icc-error" role="alert" data-testid="integration-connect-error">
            <Warning size={13} weight="fill" />
            <span>{shownError}</span>
          </div>
        ) : null}
      </div>

      <div className="ade-icc-foot">
        <span className="ade-icc-saved">
          <LockKey size={11} weight="bold" />
          {card.savedNote ?? spec.savedWhere} Never shown to the agent.
        </span>
        <span className="ade-icc-foot-actions">
          <button type="button" className="ade-icc-quiet" onClick={openSettings} data-testid="integration-connect-settings">
            <GearSix size={12} />
            Open in Settings
          </button>
          <button
            type="button"
            className="ade-icc-quiet"
            disabled={responding}
            data-testid="integration-connect-decline"
            onClick={onDecline}
          >
            Not now
          </button>
        </span>
      </div>
    </div>
  );
}

const METHOD_RECEIPT: Record<ConnectMethodId, string> = {
  oauth: "through the browser",
  api_key: "with an API key",
  token: "with an access token",
  site_token: "with an API token",
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

