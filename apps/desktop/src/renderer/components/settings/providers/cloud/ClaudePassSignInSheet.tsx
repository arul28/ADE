/**
 * "Sign in to Claude on ADE Cloud": the approve of a Claude pass, from the
 * Claude tile and from Claude's ADE Cloud page. Which account, then Claude
 * Code's own sign-in in the browser, then ADE checks which account the pass
 * is for. The end states: signed in, the wrong account (Keep it or Try
 * again), kept on this computer for now, and failed.
 *
 * The approve runs on this computer's ADE background service, account-wide,
 * so the calls take no pin. The service pushes no progress event, so while
 * it runs (and only while this sheet is open) the sheet reads it every
 * 1.5 s: the poll of the cloud sign-ins card, moved here. It stops at any
 * other state. The sign-in page opens once, from the window that started it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, CircleNotch, Info } from "@phosphor-icons/react";
import type { CloudSignInClaudeStartArgs, CloudSignInStatus } from "../../../../../shared/cloudSignIns";
import { ipcErrorMessage } from "../../../../lib/format";
import { openExternalUrl } from "../../../../lib/openExternal";
import { COLORS, outlineButton } from "../../../lanes/laneDesignTokens";
import { Dialog, type DialogAction } from "../../../ui/dialog";
import { Banner } from "../../../ui/notice/Banner";
import { providerBrand, providerThemeVars } from "../providerBrand";
import { formatSignInFailureReport } from "../providerDiagnosticsReport";
import { SHEET_PANEL_PLACEMENT } from "../ProviderSignInSheet";
import {
  SignInAccountNote,
  SignInBanner,
  SignInCodePanel,
  SignInFailure,
  SignInFooterStatus,
  SignInMismatch,
  SignInPasteBox,
  SignInSteps,
  type SignInStage,
} from "../signInSheetParts";

/** How often the sheet reads the approve while it runs (the cloud sign-ins card's own rate). */
const APPROVE_POLL_MS = 1_500;

export type ClaudePassRequest = {
  /** The pass a Renew replaces; null for a new pass. */
  renewKey: string | null;
  /** A Renew's account (the pass's email); the picker decides for a new pass. */
  forEmail: string | null;
};

type Claude = NonNullable<CloudSignInStatus["claude"]>;
const LIVE_STATES = new Set<Claude["state"]>(["running", "verifying", "saving"]);
/** "Another account": no account pressed; Claude names it after the approve. */
const ANOTHER = "__another__";

export function ClaudePassSignInSheet({
  request,
  status,
  applyStatus,
  reload,
  onSaved,
  onClose,
}: {
  request: ClaudePassRequest;
  /** The account's cloud sign-in read (`cloud.cloudSignInStatus`), shared with the page. */
  status: CloudSignInStatus | null;
  applyStatus: (status: CloudSignInStatus | null | undefined) => void;
  reload: () => Promise<void>;
  /** A pass was saved (in the account, or on this computer for now): read the account again. */
  onSaved: () => void;
  onClose: () => void;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.ade?.cloud;
  const claude = status?.claude ?? null;
  const live = claude ? LIVE_STATES.has(claude.state) : false;
  const waitingOnPerson = claude?.state === "mismatch";
  const accounts = status?.localAccounts ?? [];

  // ── Which account (a new pass only; a Renew is for its own account) ──
  const [picked, setPicked] = useState<string | null>(null);
  const defaultPick = accounts.find((account) => account.isDefault)?.email ?? accounts[0]?.email ?? ANOTHER;
  const pick = picked ?? defaultPick;

  // ── The flow ──
  // This sheet started (or found running) the approve it shows. Before that,
  // an old end state from an earlier approve is not this sheet's. While a
  // start is on its way the read still holds that old state, so the sheet
  // joins only when the start's own status is in.
  const [joined, setJoined] = useState(() => live || waitingOnPerson);
  const [starting, setStarting] = useState(false);
  const opensPageRef = useRef(false);
  const lastArgsRef = useRef<CloudSignInClaudeStartArgs>({ forEmail: request.forEmail, renewKey: request.renewKey });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const call = useCallback(async (action: () => Promise<CloudSignInStatus | null | undefined> | undefined): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (mountedRef.current) applyStatus(next);
      return true;
    } catch (callError) {
      if (mountedRef.current) setError(ipcErrorMessage(callError) || "That didn't work. Try again.");
      return false;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [applyStatus]);

  const start = useCallback(async (forEmail: string | null) => {
    const args: CloudSignInClaudeStartArgs = { forEmail, renewKey: request.renewKey };
    lastArgsRef.current = args;
    opensPageRef.current = true;
    setJoined(false);
    setStarting(true);
    setCode("");
    const ok = await call(() => bridge?.cloudSignInClaudeStart?.(args));
    if (!mountedRef.current) return;
    setStarting(false);
    if (ok) setJoined(true);
    else opensPageRef.current = false;
  }, [bridge, call, request.renewKey]);

  // An approve already running (from another window, or before this sheet opened) is the one to show.
  useEffect(() => {
    if (!joined && !starting && (live || waitingOnPerson)) setJoined(true);
  }, [joined, live, starting, waitingOnPerson]);

  // A Renew, or a computer with no Claude account to pick from, starts at once (once the read is in).
  const autoStartedRef = useRef(false);
  const needsPick = request.renewKey == null && accounts.length > 0;
  useEffect(() => {
    if (autoStartedRef.current || joined || starting || live || waitingOnPerson || !status || needsPick) return;
    autoStartedRef.current = true;
    void start(request.renewKey != null ? request.forEmail : null);
  }, [joined, live, needsPick, request.forEmail, request.renewKey, start, starting, status, waitingOnPerson]);

  // The approve runs on the service with no progress event: read it while it runs, and only then.
  useEffect(() => {
    if (!joined || !live) return undefined;
    const timer = window.setInterval(() => void reload(), APPROVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [joined, live, reload]);

  // The page opens once, when Claude Code prints its link, and only from the window that started it.
  const url = joined && claude?.state === "running" ? claude.url : null;
  useEffect(() => {
    if (joined && !live) opensPageRef.current = false;
  }, [joined, live]);
  useEffect(() => {
    if (url && opensPageRef.current) {
      opensPageRef.current = false;
      openExternalUrl(url);
    }
  }, [url]);

  // A saved pass: the account part reads it again, once per approve.
  const savedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!joined || !claude?.savedKey) return;
    if (claude.state !== "succeeded" && claude.state !== "saved_here") return;
    if (savedKeyRef.current === claude.savedKey) return;
    savedKeyRef.current = claude.savedKey;
    onSaved();
  }, [claude?.savedKey, claude?.state, joined, onSaved]);

  // Stopped (here or in another window): nothing more to show.
  useEffect(() => {
    if (joined && claude?.state === "cancelled") onClose();
  }, [claude?.state, joined, onClose]);

  /** Close; a running approve (or one waiting on Keep / Try again) stops. */
  const close = useCallback(() => {
    if (starting || (joined && (live || waitingOnPerson))) {
      void bridge?.cloudSignInClaudeCancel?.()?.catch(() => undefined);
    }
    onClose();
  }, [bridge, joined, live, onClose, starting, waitingOnPerson]);

  const tryAgain = useCallback(async () => {
    // Leave the old approve first, so its stop does not close the sheet.
    setJoined(false);
    await call(() => bridge?.cloudSignInClaudeCancel?.());
    await start(lastArgsRef.current.forEmail ?? null);
  }, [bridge, call, start]);

  const keep = useCallback(() => {
    void call(() => bridge?.cloudSignInClaudeKeep?.());
  }, [bridge, call]);

  const submitCode = useCallback(() => {
    const value = code.trim();
    if (!value) return;
    void call(async () => {
      const next = await bridge?.cloudSignInClaudeCode?.(value);
      if (mountedRef.current) setCode("");
      return next;
    });
  }, [bridge, call, code]);

  // ── What the sheet shows ──
  const flow = joined ? claude : null;
  const expected = flow?.forEmail ?? lastArgsRef.current.forEmail ?? null;
  const stage: SignInStage | "pick" | "reading" | "saving" | "succeeded" | "saved_here" =
    starting ? "starting"
    : !flow
      ? (status ? (needsPick ? "pick" : error ? "failed" : "starting") : "reading")
      : flow.state === "running" ? (flow.url || flow.awaitingCode ? "waiting" : "starting")
        : flow.state === "verifying" ? "verifying"
          : flow.state === "saving" ? "saving"
            : flow.state === "mismatch" ? "mismatch"
              : flow.state === "succeeded" ? "succeeded"
                : flow.state === "saved_here" ? "saved_here"
                  : flow.state === "failed" ? "failed"
                    : "starting";
  const running = stage === "starting" || stage === "waiting" || stage === "verifying" || stage === "saving";
  const brand = providerBrand("claude");
  const title = request.renewKey ? "Renew your Claude pass" : "Sign in to Claude";
  const closeLabel = "Close Claude sign-in";

  const report = useMemo(() => {
    if (stage !== "failed" || !flow) return null;
    return formatSignInFailureReport({
      provider: "claude",
      providerLabel: "Claude",
      place: "this computer",
      stage: flow.url ? "after the sign-in page opened" : "before the sign-in page opened",
      title: "Claude sign-in didn't finish",
      detail: flow.message,
      output: null,
      secrets: [flow.url],
    });
  }, [flow, stage]);

  const actions: DialogAction[] = stage === "pick"
    ? [
        { label: "Cancel", onClick: close, variant: "secondary" },
        { label: "Continue", onClick: () => void start(pick === ANOTHER ? null : pick), disabled: busy, variant: "solid" },
      ]
    : running
      ? [{ label: "Cancel", onClick: close, variant: "secondary" }]
      : stage === "failed"
        ? [
            { label: "Close", onClick: close, variant: "secondary" },
            { label: "Try again", onClick: () => void tryAgain(), disabled: busy, variant: "solid" },
          ]
        : stage === "succeeded" || stage === "saved_here"
          ? [{ label: "Done", onClick: close, variant: "solid" }]
          : [];

  const steps: SignInStage = stage === "saving" ? "verifying" : stage === "succeeded" || stage === "saved_here" ? "done" : (stage as SignInStage);
  const found = flow?.foundEmail ?? null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={title}
      hideHeader
      titleInBody
      closeLabel={closeLabel}
      closeOnScrimClick={!running && !waitingOnPerson}
      width={540}
      preventAutoFocus
      bodyPadding={false}
      scrollBody={false}
      bodyStyle={{ display: "flex", flexDirection: "column" }}
      tone="accent"
      panelStyle={{ ...providerThemeVars(brand), ...SHEET_PANEL_PLACEMENT }}
      footerStart={running ? (
        <SignInFooterStatus>
          <CircleNotch size={13} className="animate-spin motion-reduce:animate-none" />
          {stage === "saving" ? "Saving to your ADE account…" : stage === "verifying" ? "Checking the account…" : stage === "starting" ? "Starting the sign-in…" : "Waiting for you to approve in the browser"}
        </SignInFooterStatus>
      ) : undefined}
      actions={actions}
    >
      <div className="ade-sis" data-sheet="true" data-testid="claude-pass-sign-in">
        <SignInBanner providerId="claude" title={title} place="on ADE Cloud" turn={stage === "succeeded"} onClose={close} closeLabel={closeLabel} />
        <div className="ade-sis-body">
          {error ? <Banner layout="inline" model={{ id: "claude-pass-sign-in-error", tone: "error", title: error }} /> : null}

          {stage === "reading" ? <span className="ade-sis-hint">Reading your Claude accounts…</span> : null}

          {stage === "pick" ? (
            <div className="ade-sis-form">
              <span className="ade-sis-form-label">Which Claude account?</span>
              <div role="radiogroup" aria-label="Claude account" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[...accounts.map((account) => ({ value: account.email, label: account.email })), { value: ANOTHER, label: "Another account" }].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={pick === option.value}
                    onClick={() => setPicked(option.value)}
                    style={{
                      ...outlineButton({ height: 36, padding: "0 12px", fontSize: 12.5 }),
                      justifyContent: "flex-start",
                      gap: 9,
                      borderColor: pick === option.value ? COLORS.accent : undefined,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 999,
                        flex: "none",
                        boxShadow: `inset 0 0 0 ${pick === option.value ? 4 : 1.5}px ${pick === option.value ? COLORS.accent : COLORS.outlineBorder}`,
                      }}
                    />
                    {option.label}
                  </button>
                ))}
              </div>
              <span className="ade-sis-hint">A pass lets cloud chats use your Claude plan. It lasts about a year.</span>
            </div>
          ) : null}

          {stage === "pick" || running ? <SignInAccountNote providerLabel="Claude" expectedAccount={stage === "pick" ? (pick === ANOTHER ? null : pick) : expected} /> : null}

          {running || stage === "succeeded" || stage === "saved_here" ? (
            <SignInSteps stage={steps}>
              <SignInCodePanel url={url} deviceCode={null} hint="Approve in the browser. Claude then shows a code." focusOpen={!flow?.awaitingCode} />
              {flow?.awaitingCode ? (
                <SignInPasteBox
                  label="Paste the code Claude shows"
                  value={code}
                  onChange={setCode}
                  onSubmit={submitCode}
                  submitting={busy}
                  submitLabel="Continue"
                  autoFocus
                />
              ) : null}
            </SignInSteps>
          ) : null}

          {stage === "succeeded" ? (
            <div className="ade-sis-end" data-tone="ok" role="status">
              <CheckCircle size={18} weight="fill" />
              <span className="ade-sis-end-text">
                {flow?.check === "unchecked" ? (
                  <>
                    <span className="ade-sis-end-title">{expected ? `Signed in. Labelled ${expected}.` : "Signed in."}</span>
                    {expected ? <span className="ade-sis-end-detail">ADE couldn't check this account.</span> : null}
                  </>
                ) : (
                  <span className="ade-sis-end-title">{found ? `Signed in as ${found}.` : "Signed in to Claude."}</span>
                )}
              </span>
            </div>
          ) : null}

          {stage === "saved_here" ? (
            <div className="ade-sis-end" data-tone="neutral" role="status">
              <Info size={18} weight="fill" />
              <span className="ade-sis-end-text">
                <span className="ade-sis-end-title">Saved on this computer for now</span>
                {flow?.message ? <span className="ade-sis-end-detail">{flow.message}</span> : null}
              </span>
            </div>
          ) : null}

          {stage === "mismatch" && expected && found ? (
            <SignInMismatch expected={expected} actual={found} onKeep={keep} onTryAgain={() => void tryAgain()} />
          ) : null}

          {stage === "failed" ? (
            <SignInFailure title="Claude sign-in didn't finish" detail={flow?.message ?? null} report={report} />
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
