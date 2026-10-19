/**
 * Antigravity sign-in on the machine the Settings page shows.
 *
 * Google's Antigravity agent has no terminal login: sign-in is its ACP
 * `authenticate` request, which ADE runs with its pinned agent on that
 * machine (`ai.antigravitySignIn*`, routed by `useSettingsMachineScope().pin`;
 * start, status reads, a pasted address and cancel all go to that one
 * machine). For a Google account the agent waits for Google to send the
 * browser back to a 127.0.0.1 address on that machine:
 *
 * - This computer: ADE opens the Google page; the browser lands on the
 *   agent's listener by itself.
 * - Another machine (or the web client): open the page anywhere, then paste
 *   the full address the browser ends on (it will not load). ADE checks it
 *   and hands it to the agent there.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, Copy, SignIn, X } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton, primaryButton } from "../../../lanes/laneDesignTokens";
import { Banner } from "../../../ui/notice";
import { useSettingsMachineScope } from "../../SettingsMachineScope";
import { useSettingsAction } from "../../useSettingsAction";
import { usePolling } from "../../../../hooks/usePolling";
import type { AntigravityAuthMethod, AntigravitySignInState } from "../../../../../shared/types/config";
import type { ProvidersViewContext } from "../types";

const POLL_MS = 1_000;

const METHODS: ReadonlyArray<{ id: AntigravityAuthMethod; label: string; hint: string }> = [
  { id: "oauth-personal", label: "Google account", hint: "Sign in with your Google account in a browser." },
  {
    id: "oauth-business",
    label: "Gemini Enterprise",
    hint: "Sign in with your work account, then choose your license on the page Antigravity serves. That page opens only in a browser on the machine that runs Antigravity.",
  },
  { id: "gemini-api-key", label: "Gemini API key", hint: "Uses the Gemini API key saved under API keys on this page." },
  {
    id: "agent-platform",
    label: "Agent Platform",
    hint: "Gemini Enterprise Agent Platform (formerly Vertex AI): an API key, or a project and location with Application Default Credentials on that machine.",
  },
];

const METHOD_LABEL: Record<AntigravityAuthMethod, string> = Object.fromEntries(
  METHODS.map((method) => [method.id, method.label]),
) as Record<AntigravityAuthMethod, string>;

function running(state: AntigravitySignInState | null): boolean {
  return state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying";
}

const textInput: React.CSSProperties = {
  height: 28,
  padding: "0 8px",
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  background: "transparent",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 6,
  minWidth: 0,
};

export function AntigravitySignIn({ ctx }: { ctx: ProvidersViewContext }) {
  const { pin, isThisMachine, machineName } = useSettingsMachineScope();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const action = useSettingsAction();
  const runAction = action.run;
  const refreshStatus = ctx.actions.refreshStatus;
  const [state, setState] = useState<AntigravitySignInState | null>(null);
  const [method, setMethod] = useState<AntigravityAuthMethod>("oauth-personal");
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [returnUrl, setReturnUrl] = useState("");
  const openedFlowRef = useRef<string | null>(null);
  const finishedFlowRef = useRef<string | null>(null);
  const supported = Boolean(window.ade?.ai?.antigravitySignInStatus);

  const apply = useCallback((next: AntigravitySignInState | null) => {
    if (!next) return;
    setState(next);
    if (next.recordedMethod && !running(next)) setMethod(next.recordedMethod);
    if (next.agentPlatform.project) setProject((current) => current || next.agentPlatform.project || "");
    if (next.agentPlatform.location) setLocation((current) => current || next.agentPlatform.location || "");
    // Open Google's page once per flow, only when the browser is on that machine.
    if (next.phase === "waiting" && next.authorizationUrl && next.flowId && openedFlowRef.current !== next.flowId) {
      openedFlowRef.current = next.flowId;
      if (isThisMachine) void window.ade?.app?.openExternal?.(next.authorizationUrl);
    }
    if (next.phase === "succeeded" && next.flowId && finishedFlowRef.current !== next.flowId) {
      finishedFlowRef.current = next.flowId;
      void refreshStatus({ force: true, silent: true });
    }
  }, [isThisMachine, refreshStatus]);

  // One read per machine.
  useEffect(() => {
    const read = window.ade?.ai?.antigravitySignInStatus;
    if (!read) return undefined;
    let cancelled = false;
    void read(pinRef.current)
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Keyed on the machine, not the pin object (a rebuilt pin keeps its key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey]);

  usePolling(async () => {
    const read = window.ade?.ai?.antigravitySignInStatus;
    if (!read) return;
    apply(await read(pinRef.current).catch(() => null));
  }, POLL_MS, running(state));

  const start = useCallback(() => runAction("start", async () => {
    const begin = window.ade?.ai?.antigravitySignInStart;
    if (!begin) throw new Error(`ADE on ${machineName} cannot sign in to Antigravity yet. Update ADE there and try again.`);
    setReturnUrl("");
    apply(await begin({
      method,
      ...(method === "agent-platform"
        ? { agentPlatform: { project: project.trim() || null, location: location.trim() || null, apiKey: apiKey.trim() || null } }
        : {}),
    }, pinRef.current));
    setApiKey("");
  }), [runAction, apply, apiKey, location, machineName, method, project]);

  const cancel = useCallback(() => runAction("cancel", async () => {
    const flowId = state?.flowId;
    const stop = window.ade?.ai?.antigravitySignInCancel;
    if (!flowId || !stop) return;
    apply(await stop({ flowId }, pinRef.current));
  }), [runAction, apply, state?.flowId]);

  const complete = useCallback(() => runAction("complete", async () => {
    const flowId = state?.flowId;
    const send = window.ade?.ai?.antigravitySignInComplete;
    if (!flowId || !send) return;
    apply(await send({ flowId, callbackUrl: returnUrl.trim() }, pinRef.current));
    setReturnUrl("");
  }), [runAction, apply, returnUrl, state?.flowId]);

  if (!supported) {
    return (
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
        This window cannot sign in to Antigravity.
      </div>
    );
  }

  const busy = running(state);
  const methodHint = METHODS.find((entry) => entry.id === method)?.hint ?? "";
  const signedInLine = state?.signedIn && state.recordedMethod
    ? `Signed in on ${machineName} with ${METHOD_LABEL[state.recordedMethod]}.`
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {signedInLine && !busy ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>{signedInLine}</div>
      ) : null}

      {!busy ? (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
            Sign-in method
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value as AntigravityAuthMethod)}
              style={{ ...textInput, fontFamily: SANS_FONT }}
            >
              {METHODS.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label}</option>
              ))}
            </select>
          </label>
          <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>{methodHint}</div>
          {method === "agent-platform" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <input aria-label="Google Cloud project" placeholder="Project (optional with an API key)" value={project} onChange={(event) => setProject(event.target.value)} style={textInput} />
              <input aria-label="Google Cloud location" placeholder="Location, e.g. global or us-central1" value={location} onChange={(event) => setLocation(event.target.value)} style={textInput} />
              <input aria-label="Agent Platform API key" type="password" placeholder="API key (optional; saved in ADE's key store there)" value={apiKey} onChange={(event) => setApiKey(event.target.value)} style={textInput} />
            </div>
          ) : null}
          <button
            type="button"
            disabled={action.busy === "start"}
            onClick={() => void start()}
            style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
          >
            <SignIn size={13} />{" "}
            {method === "oauth-personal" || method === "oauth-business"
              ? state?.signedIn ? "Sign in again" : "Sign in"
              : "Connect"}
          </button>
          <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
            Runs ADE's copy of Antigravity on {machineName} (downloading it first if needed). The login is the
            agent's own, shared with other apps that use it there.
          </div>
        </>
      ) : null}

      {busy && state ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: 1.5 }}>
            {state.message ?? "Working…"}
          </div>
          {state.authorizationUrl ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <button
                type="button"
                onClick={() => void window.ade?.app?.openExternal?.(state.authorizationUrl!)}
                style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
              >
                <ArrowSquareOut size={13} /> Open Google sign-in
              </button>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(state.authorizationUrl!).catch(() => undefined)}
                style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
              >
                <Copy size={13} /> Copy link
              </button>
            </div>
          ) : null}
          {state.licensePickerUrl ? (
            <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5, overflowWrap: "anywhere" }}>
              License page (open it in a browser on {machineName}):{" "}
              <code style={{ fontFamily: MONO_FONT }}>{state.licensePickerUrl}</code>
            </div>
          ) : null}
          {state.acceptsCallbackUrl ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                {isThisMachine
                  ? "If the browser you signed in with is on another computer, its last page will not load. Paste that page's full address here."
                  : `Google sends the browser back to an address on ${machineName}, so the last page will not load here. Paste its full address (starting with http://127.0.0.1) and choose Continue. It holds a one-time sign-in code: paste it only here.`}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  aria-label="Return address"
                  placeholder="http://127.0.0.1:…/?state=…&code=…"
                  value={returnUrl}
                  onChange={(event) => setReturnUrl(event.target.value)}
                  style={{ ...textInput, flex: 1 }}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  disabled={!returnUrl.trim() || action.busy === "complete"}
                  onClick={() => void complete()}
                  style={primaryButton({ height: 28, padding: "0 12px", fontSize: 12 })}
                >
                  Continue
                </button>
              </div>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => void cancel()}
            style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
          >
            <X size={13} /> Cancel
          </button>
        </div>
      ) : null}

      {!busy && state && (state.phase === "failed" || state.phase === "succeeded" || state.phase === "cancelled") && state.message ? (
        <Banner
          layout="inline"
          model={{
            id: `antigravity-sign-in-${state.phase}`,
            tone: state.phase === "failed" ? "error" : state.phase === "succeeded" ? "success" : "info",
            title: state.message,
          }}
        />
      ) : null}
      {action.error ? <Banner layout="inline" model={{ id: "antigravity-sign-in-error", tone: "error", title: action.error }} /> : null}
    </div>
  );
}
