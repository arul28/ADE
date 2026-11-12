/**
 * Antigravity sign-in on the machine the Settings page shows.
 *
 * ADE runs the sign-in with its pinned Antigravity CLI on that machine
 * (`ai.antigravitySignIn*`, routed by `useSettingsMachineScope().pin`; start,
 * status reads, the pasted code and cancel all go to that one machine).
 *
 * - Google account: the CLI's `agy acp --login`. Google's page shows a code
 *   once the person approves, in a browser on any computer; it is pasted
 *   here and ADE hands it to the CLI there.
 * - Gemini Enterprise: the agent's ACP `authenticate`, which opens a browser
 *   on that machine and waits for Google to come back to it there.
 *
 * The page keeps the method and the flow; a running sign-in shows in the
 * shared sign-in sheet (`AntigravitySignInSheetView`). Closing the sheet
 * mid-flow stops the sign-in on that machine.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { SignIn, X } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { AntigravitySignInSheetView } from "../ProviderSignInSheet";
import { signInMachineWords } from "../signInSheetParts";
import { Banner } from "../../../ui/notice";
import { useSettingsMachineScope } from "../../SettingsMachineScope";
import { useSettingsAction } from "../../useSettingsAction";
import { usePolling } from "../../../../hooks/usePolling";
import { isAntigravitySignInRunning, type AntigravityAuthMethod, type AntigravitySignInState } from "../../../../../shared/types/config";
import type { ProvidersViewContext } from "../types";

const POLL_MS = 1_000;

const METHODS: ReadonlyArray<{ id: AntigravityAuthMethod; label: string; hint: string }> = [
  { id: "oauth-personal", label: "Google account", hint: "Sign in with your Google account in a browser on any computer, then paste the code Google shows." },
  {
    id: "oauth-business",
    label: "Gemini Enterprise",
    hint: "Sign in with your work account. Antigravity opens the browser itself, so this finishes only on the machine that runs it.",
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
  /** The machine inside a sentence: "this computer" here, else its name. */
  const where = signInMachineWords(isThisMachine, machineName);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const action = useSettingsAction();
  const runAction = action.run;
  const refreshStatus = ctx.actions.refreshStatus;
  const verifySignIn = ctx.actions.verifySignIn;
  const [state, setState] = useState<AntigravitySignInState | null>(null);
  const [method, setMethod] = useState<AntigravityAuthMethod>("oauth-personal");
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("");
  const [apiKey, setApiKey] = useState("");
  /**
   * The sheet is up. A fresh sheet shows only a state newer than the one on
   * screen when it opened (`since`, the old state itself), so an earlier
   * flow's end is not read as this one's; a sheet opened to watch a running
   * flow shows the current one.
   */
  const [sheet, setSheet] = useState<{ fresh: true; since: AntigravitySignInState | null } | { fresh: false } | null>(null);
  const openedFlowRef = useRef<string | null>(null);
  const finishedFlowRef = useRef<string | null>(null);
  /** The flow this page watched run, so an old success read on open does not start a check. */
  const watchedFlowRef = useRef<string | null>(null);
  const supported = Boolean(window.ade?.ai?.antigravitySignInStatus);

  const apply = useCallback((next: AntigravitySignInState | null) => {
    if (!next) return;
    setState(next);
    if (next.recordedMethod && !isAntigravitySignInRunning(next)) setMethod(next.recordedMethod);
    if (next.agentPlatform.project) setProject((current) => current || next.agentPlatform.project || "");
    if (next.agentPlatform.location) setLocation((current) => current || next.agentPlatform.location || "");
    // Open Google's page once per flow, only when the browser is on that machine.
    if (next.phase === "waiting" && next.authorizationUrl && next.flowId && openedFlowRef.current !== next.flowId) {
      openedFlowRef.current = next.flowId;
      if (isThisMachine) void window.ade?.app?.openExternal?.(next.authorizationUrl);
    }
    if (next.flowId && isAntigravitySignInRunning(next)) watchedFlowRef.current = next.flowId;
    if (next.phase === "succeeded" && next.flowId && finishedFlowRef.current !== next.flowId) {
      finishedFlowRef.current = next.flowId;
      void (watchedFlowRef.current === next.flowId
        ? verifySignIn("antigravity")
        : refreshStatus({ force: true, silent: true }));
    }
  }, [isThisMachine, refreshStatus, verifySignIn]);

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
  }, POLL_MS, isAntigravitySignInRunning(state));

  const start = useCallback(() => runAction("start", async () => {
    const begin = window.ade?.ai?.antigravitySignInStart;
    if (!begin) throw new Error(`ADE on ${where} cannot sign in to Antigravity yet. Update ADE there and try again.`);
    apply(await begin({
      method,
      ...(method === "agent-platform"
        ? { agentPlatform: { project: project.trim() || null, location: location.trim() || null, apiKey: apiKey.trim() || null } }
        : {}),
    }, pinRef.current));
    setApiKey("");
  }), [runAction, apply, apiKey, location, where, method, project]);

  const cancel = useCallback(() => runAction("cancel", async () => {
    const flowId = state?.flowId;
    const stop = window.ade?.ai?.antigravitySignInCancel;
    if (!flowId || !stop) return;
    apply(await stop({ flowId }, pinRef.current));
  }), [runAction, apply, state?.flowId]);

  const complete = useCallback((address: string) => runAction("complete", async () => {
    const flowId = state?.flowId;
    const send = window.ade?.ai?.antigravitySignInComplete;
    if (!flowId || !send) return;
    apply(await send({ flowId, callbackUrl: address.trim() }, pinRef.current));
  }), [runAction, apply, state?.flowId]);

  const openSheetAndStart = useCallback(() => {
    setSheet({ fresh: true, since: state });
    void start();
  }, [start, state]);

  const closeSheet = useCallback(() => {
    if (isAntigravitySignInRunning(state)) void cancel();
    setSheet(null);
  }, [cancel, state]);

  if (!supported) {
    return (
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
        This window cannot sign in to Antigravity.
      </div>
    );
  }

  const busy = isAntigravitySignInRunning(state);
  const methodHint = METHODS.find((entry) => entry.id === method)?.hint ?? "";
  const signedInLine = state?.signedIn && state.recordedMethod
    ? `Signed in on ${where} with ${METHOD_LABEL[state.recordedMethod]}.`
    : null;
  const sheetState = !sheet
    ? null
    : sheet.fresh
      ? state && state !== sheet.since ? state : null
      : state;

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
            onClick={openSheetAndStart}
            style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
          >
            <SignIn size={13} />{" "}
            {method === "oauth-personal" || method === "oauth-business"
              ? state?.signedIn ? "Sign in again" : "Sign in"
              : "Connect"}
          </button>
          <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
            Runs ADE's copy of Antigravity on {where} (downloading it first if needed). The login is the
            agent's own, shared with other apps that use it there.
          </div>
        </>
      ) : null}

      {busy && state && !sheet ? (
        // A sign-in already running (started from a chat, or before the page opened).
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: 1.5 }}>
            A sign-in to Antigravity is running on {where}.
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button
              type="button"
              onClick={() => setSheet({ fresh: false })}
              style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
            >
              <SignIn size={13} /> Show the sign-in
            </button>
            <button
              type="button"
              onClick={() => void cancel()}
              style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
            >
              <X size={13} /> Cancel
            </button>
          </div>
        </div>
      ) : null}

      {!busy && !sheet && state && (state.phase === "failed" || state.phase === "succeeded" || state.phase === "cancelled") && state.message ? (
        <Banner
          layout="inline"
          model={{
            id: `antigravity-sign-in-${state.phase}`,
            tone: state.phase === "failed" ? "error" : state.phase === "succeeded" ? "success" : "info",
            title: state.message,
          }}
        />
      ) : null}
      {action.error && !sheet ? <Banner layout="inline" model={{ id: "antigravity-sign-in-error", tone: "error", title: action.error }} /> : null}

      {sheet ? (
        <AntigravitySignInSheetView
          state={sheetState}
          starting={action.busy === "start" || (sheet.fresh && !sheetState && !action.error)}
          machine={{ pin, isThisMachine, machineName }}
          submitting={action.busy === "complete"}
          onSubmitAddress={(address) => void complete(address)}
          onClose={closeSheet}
          onTryAgain={openSheetAndStart}
          error={action.error}
        />
      ) : null}
    </div>
  );
}
