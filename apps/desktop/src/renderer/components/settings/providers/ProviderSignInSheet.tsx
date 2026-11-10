/**
 * The one sign-in sheet for Settings and first setup: the provider's banner,
 * the account note, three steps, the code, the paste box, and the end states
 * (`signInSheetParts`). In a chat there is no sheet; the chat card
 * (`chat/ProviderSignInCard`) draws the same parts in the prompt box's place.
 *
 * Each provider keeps its own flow, with the same calls, the same machine and
 * the same states as before; only the screen is shared:
 *
 * - Claude Code and Codex: an account's own login in a private PTY on its
 *   machine (`providerInstances.login*`). `AccountSignInSheet`.
 * - Grok, Devin, Muse, Copilot, Droid, Kimi: the CLI's own login run by ADE
 *   (`ai.cliLogin*`). `CliSignInSheet`.
 * - Qwen, and those CLIs on a machine whose ADE is too old for the above: the
 *   login command in a terminal inside step 2 (`pty.create`).
 *   `TerminalSignInSheet`.
 * - Antigravity and Cursor: their owners keep the flow (the Settings page,
 *   the setup card) and render `AntigravitySignInSheetView` or
 *   `CursorSignInSheetView`.
 *
 * Every call of one sign-in goes to the machine its `pin` names: the start,
 * its status reads, a pasted code and the cancel. Closing a sheet mid-flow
 * (Cancel, Esc, the ×) stops the sign-in there.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleNotch, ShieldCheck, SignIn } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../lanes/laneDesignTokens";
import { Dialog, type DialogAction } from "../../ui/dialog";
import { Banner } from "../../ui/notice/Banner";
import { TerminalView } from "../../terminals/TerminalView";
import { isWebClientMode } from "../../../lib/webClientMode";
import { openExternalUrl } from "../../../lib/openExternal";
import { isUnsupportedAdeActionError } from "../../../../shared/codedError";
import {
  isAntigravitySignInRunning,
  isProviderLoginLive,
  type AgentCliLoginProvider,
  type AgentCliLoginStatus,
  type AntigravitySignInState,
  type KimiLoginRegion,
  type OpenProjectBinding,
  type TerminalToolType,
} from "../../../../shared/types";
import type { ProviderInstance, ProviderInstanceProvider, ProviderLoginStatus } from "../../../../shared/types/providerInstances";
import { accountIdentityLine } from "./accounts/accountPresentation";
import { pinnedProviderInstances } from "./accounts/useProviderInstances";
import { providerBrand, providerThemeVars } from "./providerBrand";
import { formatSignInFailureReport } from "./providerDiagnosticsReport";
import { providerActionMessage } from "./providerErrorMessage";
import {
  OutputDisclosure,
  SignInAccountNote,
  SignInBanner,
  SignInCodePanel,
  SignInFailure,
  SignInFooterStatus,
  SignInMismatch,
  SignInPasteBox,
  SignInSteps,
  SignInSuccess,
  linkHost,
  signInAccountMismatch,
  signInMachineWords,
  signInPlace,
  signInRunning,
  useEnterOpensSignInPage,
  type SignInStage,
} from "./signInSheetParts";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import type { ProvidersViewContext } from "./types";

/**
 * The sheet's top edge, fixed for the whole sign-in: a centered panel moves
 * its banner each time the body changes height (form, wait, check, done).
 * `--ade-web-zoom-factor` keeps the viewport units right in the web client.
 */
const SHEET_TOP = "clamp(16px, calc(10vh / var(--ade-web-zoom-factor, 1)), 80px)";
const SHEET_PANEL_PLACEMENT: React.CSSProperties = {
  top: SHEET_TOP,
  bottom: "auto",
  marginTop: 0,
  marginBottom: 0,
  // The rest of the window under the top edge, less a 16 px gap: the body
  // scrolls inside it (a 600 px window gives about 524 px).
  maxHeight: `calc(100vh / var(--ade-web-zoom-factor, 1) - ${SHEET_TOP} - 16px)`,
};

/** How long "Signed in" stays up before the sheet closes itself. */
const SUCCESS_HOLD_MS = 1_600;
/** Status read while a host's sign-in runs (the same 1 s each flow used before). */
const STATUS_POLL_MS = 1_000;
/** Status reads that may fail in a row (a relay hiccup) before the CLI sheet gives up. */
const STATUS_READ_RETRIES = 3;
/** The terminal sign-in re-reads the saved login this often (its old cadence). */
const TERMINAL_AUTH_POLL_MS = 4_000;

/** The `ProviderLogo` / brand id for each CLI. */
const CLI_BRAND: Record<AgentCliLoginProvider, string> = {
  grok: "grok",
  devin: "devin",
  muse: "muse",
  copilot: "copilot",
  droid: "droid",
  kimi: "kimi",
};

const KIMI_REGIONS: ReadonlyArray<{ id: KimiLoginRegion; label: string; hint: string }> = [
  { id: "global", label: "kimi.ai", hint: "International accounts" },
  { id: "mainland-cn", label: "kimi.com", hint: "Mainland China accounts" },
];

/** Whether this host can run the in-app CLI sign-in (an older one has no `cliLogin*`). */
export function agentCliSignInSupported(): boolean {
  return typeof window.ade?.ai?.cliLoginStart === "function";
}

/** The machine one sheet signs in on. `pin` is null for the tab's own machine. */
type SignInMachine = {
  pin: OpenProjectBinding | null;
  /** That machine is the computer in front of the person (its browser is this one). */
  isThisMachine: boolean;
  machineName: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// The frame
// ─────────────────────────────────────────────────────────────────────────────

/** What a flow shows; the frame draws it with the shared parts. */
type SignInSheetView = {
  stage: SignInStage;
  /** A line beside step 1 while it runs ("Getting Kimi ready…"). */
  startHint?: string | null;
  url: string | null;
  deviceCode: string | null;
  /** One line under the page buttons. */
  codeHint?: React.ReactNode;
  paste?: {
    label: string;
    placeholder?: string;
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    submitting?: boolean;
    submitLabel?: string;
  } | null;
  /** More for step 2 (a license page, a terminal). */
  stepExtra?: React.ReactNode;
  /** Step 2's words when there is no browser. */
  approveLabel?: string;
  output?: string;
  /** The account ADE knew before the sign-in, or null. */
  expectedAccount: string | null;
  /** The account the provider names after it, or null. */
  account: string | null;
  failure?: { title: string; detail?: string | null; stopped?: boolean; extra?: React.ReactNode } | null;
  /** A passing error that does not end the sign-in (a refused code). */
  error?: string | null;
  /** The question asked before the sign-in starts. */
  form?: React.ReactNode;
};

type SignInSheetFrameProps = {
  providerId: string;
  providerLabel: string;
  /** The dialog's name, and the banner's title. */
  title: string;
  machine: SignInMachine;
  view: SignInSheetView;
  /** Close (Cancel, Esc, the ×, Close). A running sign-in is stopped by the owner. */
  onClose: () => void;
  onTryAgain?: () => void;
  /** Keep the other account (the mismatch end state). */
  onKeep?: () => void;
  /** The form's button. */
  continueAction?: { label: string; onClick: () => void; disabled?: boolean } | null;
  width?: number;
  closeLabel?: string;
};

function footerWords(view: SignInSheetView): string {
  if (view.stage === "starting") return view.startHint ?? "Starting the sign-in…";
  if (view.stage === "verifying") return "Checking the sign-in…";
  return view.approveLabel ? "Waiting for the terminal" : "Waiting for you to approve in the browser";
}

function SignInSheetFrame({
  providerId,
  providerLabel,
  title,
  machine,
  view,
  onClose,
  onTryAgain,
  onKeep,
  continueAction,
  width = 540,
  closeLabel,
}: SignInSheetFrameProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const brand = providerBrand(providerId);
  const running = signInRunning(view.stage);
  const place = signInPlace(machine.isThisMachine, machine.machineName);
  const mismatch = view.stage === "mismatch" && view.expectedAccount && view.account;
  const pageUrl = view.stage === "waiting" ? view.url : null;
  useEnterOpensSignInPage(rootRef, pageUrl, view.deviceCode);

  const report = useMemo(() => {
    const failure = view.failure;
    if (view.stage !== "failed" || !failure || failure.stopped) return null;
    return formatSignInFailureReport({
      provider: providerId,
      providerLabel,
      place: machine.isThisMachine ? "this computer" : "another computer",
      stage: view.url ? "after the sign-in page opened" : "before the sign-in page opened",
      title: failure.title,
      detail: failure.detail ?? null,
      output: view.output ?? null,
      secrets: [view.deviceCode, view.url],
    });
  }, [machine.isThisMachine, providerId, providerLabel, view]);

  const actions: DialogAction[] = view.stage === "form" && continueAction
    ? [{ label: continueAction.label, onClick: continueAction.onClick, disabled: continueAction.disabled, variant: "solid" }]
    : running
      ? [{ label: "Cancel", onClick: onClose, variant: "secondary" }]
      : view.stage === "failed"
        ? [
            { label: "Close", onClick: onClose, variant: "secondary" },
            ...(onTryAgain ? [{ label: "Try again", onClick: onTryAgain, variant: "solid" as const }] : []),
          ]
        : [];

  const step2 = (
    <>
      <SignInCodePanel
        url={view.url}
        deviceCode={view.deviceCode}
        hint={view.codeHint}
        focusOpen={!view.paste}
      />
      {view.paste ? (
        <SignInPasteBox
          label={view.paste.label}
          placeholder={view.paste.placeholder}
          value={view.paste.value}
          onChange={view.paste.onChange}
          onSubmit={view.paste.onSubmit}
          submitting={view.paste.submitting}
          submitLabel={view.paste.submitLabel}
          autoFocus
        />
      ) : null}
      {view.stepExtra}
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      hideHeader
      // The banner's heading names the dialog; no hidden copy of the title.
      titleInBody
      closeLabel={closeLabel ?? `Close ${providerLabel} sign-in`}
      // Closing stops the sign-in: mid-flow, only Cancel, Esc or the × do it.
      closeOnScrimClick={!running}
      width={width}
      preventAutoFocus
      bodyPadding={false}
      // The sheet scrolls its own body under a fixed banner, so the
      // scrollbar never cuts into the banner's art.
      scrollBody={false}
      bodyStyle={{ display: "flex", flexDirection: "column" }}
      tone="accent"
      panelStyle={{ ...providerThemeVars(brand), ...SHEET_PANEL_PLACEMENT }}
      footerStart={running ? (
        <SignInFooterStatus>
          <CircleNotch size={13} className="animate-spin motion-reduce:animate-none" />
          {footerWords(view)}
        </SignInFooterStatus>
      ) : undefined}
      actions={actions}
    >
      {/* The banner stays put; only the part under it scrolls (`data-sheet`). */}
      <div className="ade-sis" data-sheet="true" ref={rootRef}>
        <SignInBanner
          providerId={providerId}
          title={title}
          place={place}
          turn={view.stage === "done"}
          onClose={onClose}
          closeLabel={closeLabel ?? `Close ${providerLabel} sign-in`}
        />
        <div className="ade-sis-body">
          {view.error ? (
            <Banner layout="inline" model={{ id: `${providerId}-sign-in-error`, tone: "error", title: view.error }} />
          ) : null}
          {view.stage === "form" ? view.form : null}
          {view.stage === "form" || running ? (
            <SignInAccountNote providerLabel={providerLabel} expectedAccount={view.expectedAccount} />
          ) : null}
          {running || view.stage === "done" ? (
            <SignInSteps stage={view.stage} approveLabel={view.approveLabel} startHint={view.startHint}>
              {step2}
            </SignInSteps>
          ) : null}
          {view.stage === "done" ? <SignInSuccess account={view.account} providerLabel={providerLabel} /> : null}
          {mismatch ? (
            <SignInMismatch
              expected={view.expectedAccount!}
              actual={view.account!}
              onKeep={onKeep ?? onClose}
              onTryAgain={onTryAgain ?? onClose}
            />
          ) : null}
          {view.stage === "failed" && view.failure ? (
            <SignInFailure
              title={view.failure.title}
              detail={view.failure.detail}
              report={report}
              tone={view.failure.stopped ? "neutral" : "crit"}
            >
              {view.failure.extra}
            </SignInFailure>
          ) : null}
          {view.stage !== "form" ? <OutputDisclosure output={view.output ?? ""} /> : null}
        </div>
      </div>
    </Dialog>
  );
}

/** Close once "Signed in" has been seen, unless the account is the wrong one. */
function useSuccessHold(stage: SignInStage, close: () => void): void {
  useEffect(() => {
    if (stage !== "done") return;
    const timer = window.setTimeout(close, SUCCESS_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [close, stage]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code and Codex accounts
// ─────────────────────────────────────────────────────────────────────────────

type AccountPhase = "form" | "signing" | "success" | "failed";

function accountStartFailure(err: unknown): string {
  // A pinned machine on an ADE from before in-app sign-in has no login actions.
  if (isUnsupportedAdeActionError(err)) {
    return "That machine runs an older ADE that cannot sign in from Settings. Update ADE there, then sign in to this account again.";
  }
  return providerActionMessage(err, "That sign-in could not be started.");
}

type AccountSignInSheetProps = SignInMachine & {
  provider: ProviderInstanceProvider;
  providerLabel: string;
  /** Present when reopening sign-in for an account that already exists. */
  existingInstance?: ProviderInstance | null;
  /** The login a new account is meant for, e.g. one being added back. */
  expectedEmail?: string;
  /** Called on every close. `changed` is true once anything was written; `signedIn` only after a sign-in that worked. */
  onClose: (changed: boolean, signedIn?: boolean) => void;
};

/**
 * Add a login for one provider, or sign an existing one in again. The host
 * runs the provider's own login for THIS account's config home in a private
 * PTY (`provider_instances.loginStart`) and reports the link, a device code,
 * and whether it waits for a pasted code. The outcome is read, not assumed:
 * the host verifies the account's saved login when the CLI exits, and the
 * sheet polls that status.
 */
function AccountSignInSheet({
  provider,
  providerLabel,
  existingInstance,
  expectedEmail,
  onClose,
  pin,
  isThisMachine,
  machineName,
}: AccountSignInSheetProps) {
  const resuming = Boolean(existingInstance);
  const [phase, setPhase] = useState<AccountPhase>(resuming ? "signing" : "form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<ProviderLoginStatus | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);

  const instanceIdRef = useRef<string | null>(existingInstance?.id ?? null);
  const loginRef = useRef<ProviderLoginStatus | null>(null);
  /** Orders overlapping starts: only the newest one may apply its reply. */
  const startSeqRef = useRef(0);
  const changedRef = useRef(false);
  const signedInRef = useRef(false);
  const closedRef = useRef(false);
  const aliveRef = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // One bridge per machine, keyed on the machine (a rebuilt pin keeps its key),
  // so the poll and success effects do not restart on every parent render.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const api = useMemo(() => pinnedProviderInstances(pinRef.current), [pinKey]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const applyLogin = useCallback((next: ProviderLoginStatus) => {
    loginRef.current = next;
    if (!aliveRef.current) {
      // Closed while the start was in flight: the unmount cleanup had no
      // login to stop yet, so stop this one now.
      if (isProviderLoginLive(next)) void api?.loginCancel?.({ loginId: next.loginId }).catch(() => undefined);
      return;
    }
    setLogin(next);
    if (next.state === "succeeded") {
      changedRef.current = true;
      signedInRef.current = true;
      setSignedInAs(next.email ?? null);
      setPhase("success");
    } else if (next.state === "failed") {
      changedRef.current = true;
      setPhase("failed");
    }
  }, [api]);

  // A sign-in left running behind a closed sheet would hold the CLI open on
  // the account's machine until its timeout. Stop it.
  useEffect(() => () => {
    const open = loginRef.current;
    if (open && isProviderLoginLive(open)) void api?.loginCancel?.({ loginId: open.loginId }).catch(() => undefined);
  }, [api]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current(changedRef.current, signedInRef.current);
  }, []);

  const startLogin = useCallback(async (id: string) => {
    if (!api?.loginStart) throw new Error("This ADE host cannot run a sign-in from Settings. Update ADE on that machine.");
    const seq = ++startSeqRef.current;
    // A second start (a quick "Try again") supersedes the first; stop the one
    // still running so its CLI does not linger.
    const previous = loginRef.current;
    if (previous && isProviderLoginLive(previous)) {
      void api.loginCancel?.({ loginId: previous.loginId }).catch(() => undefined);
    }
    setError(null);
    setCode("");
    setLogin(null);
    loginRef.current = null;
    setSignedInAs(null);
    setPhase("signing");
    // On another machine, or in the hosted web client, the browser is not on
    // the account's computer, so a sign-in that returns to its localhost fails.
    const browserOnHost = isThisMachine && !isWebClientMode();
    const next = await api.loginStart({ id, ...(browserOnHost ? {} : { deviceAuth: true }) });
    // A later start replaced this reply; its status is the real one.
    if (seq !== startSeqRef.current) {
      if (isProviderLoginLive(next)) void api.loginCancel?.({ loginId: next.loginId }).catch(() => undefined);
      return;
    }
    applyLogin(next);
  }, [api, applyLogin, isThisMachine]);

  /** Start (or restart) a sign-in for an account that exists; a failure ends the sheet's attempt. */
  const runLogin = useCallback((id: string) => {
    void startLogin(id).catch((err) => {
      if (!aliveRef.current) return;
      setError(accountStartFailure(err));
      setPhase("failed");
    });
  }, [startLogin]);

  // Poll the host's sign-in while it runs.
  useEffect(() => {
    if (!api?.loginStatus || !login || !isProviderLoginLive(login)) return;
    const loginId = login.loginId;
    const timer = window.setTimeout(() => {
      void api.loginStatus({ loginId })
        .then(applyLogin)
        .catch((err) => {
          if (!aliveRef.current) return;
          setError(providerActionMessage(err, "Lost track of that sign-in."));
          setPhase("failed");
        });
    }, STATUS_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [api, applyLogin, login]);

  // The account list reads the new login on close; the usage poll is asked
  // for its first reading by naming the account. Once: the refresh publishes
  // a new usage snapshot, and that re-renders the parent.
  const refreshedRef = useRef(false);
  useEffect(() => {
    if (phase !== "success") return;
    const id = instanceIdRef.current;
    if (api && id && !refreshedRef.current) {
      refreshedRef.current = true;
      void api.refresh({ provider, instanceId: id }).catch(() => undefined);
    }
  }, [api, phase, provider]);

  // Create the account, then start its sign-in.
  const startCreate = useCallback(async () => {
    if (!api) {
      setError("Provider accounts are not available in this window.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // No name: the account is shown by the email it signs in with. A host
      // older than nameless accounts still asks for one; give it the provider's.
      const created = await api.create({ provider }).catch((err: unknown) => {
        if (!providerActionMessage(err, "").includes("needs a label")) throw err;
        return api.create({ provider, label: providerLabel });
      });
      changedRef.current = true;
      instanceIdRef.current = created.instance.id;
      if (!aliveRef.current) return;
      await startLogin(created.instance.id);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(accountStartFailure(err));
      setPhase(instanceIdRef.current ? "failed" : "form");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [api, provider, providerLabel, startLogin]);

  // Reopening sign-in for an account that already exists.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!resuming || startedRef.current || !instanceIdRef.current) return;
    startedRef.current = true;
    runLogin(instanceIdRef.current);
  }, [resuming, runLogin]);

  const tryAgain = useCallback(() => {
    const id = instanceIdRef.current;
    if (id) runLogin(id);
  }, [runLogin]);

  const submitCode = useCallback(async () => {
    const current = loginRef.current;
    if (!api?.loginSubmitCode || !current || !code.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      applyLogin(await api.loginSubmitCode({ loginId: current.loginId, code: code.trim() }));
      setCode("");
    } catch (err) {
      if (aliveRef.current) setError(providerActionMessage(err, "That code was not accepted."));
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }, [api, applyLogin, code]);

  // An account is called by its email. One that has never signed in has none
  // yet: the machine's own login is just "the provider" to the person signing
  // in (first run, the provider card), any other is "this account".
  const existingName = existingInstance
    ? existingInstance.account?.email?.trim() || (existingInstance.isDefault ? providerLabel : null)
    : null;
  const accountName = existingName ?? expectedEmail ?? "this account";
  // The account ADE knew before: the one being signed in again, or the one a
  // new account is meant for.
  const expectedAccount = existingInstance?.account?.email?.trim() || expectedEmail?.trim() || null;
  const signedInEmail = signedInAs?.trim() || null;
  const wrongAccount = phase === "success" && signInAccountMismatch(expectedAccount, signedInEmail);
  const title = resuming ? `Sign in to ${existingName ?? providerLabel}` : `Add a ${providerLabel} account`;
  const host = linkHost(login?.url ?? null);

  const stage: SignInStage = phase === "form"
    ? "form"
    : phase === "success"
      ? wrongAccount ? "mismatch" : "done"
      : phase === "failed"
        ? "failed"
        : !login
          ? "starting"
          : login.state === "verifying" ? "verifying" : "waiting";
  useSuccessHold(stage, close);

  const view: SignInSheetView = {
    stage,
    url: login?.url ?? null,
    deviceCode: login?.deviceCode ?? null,
    codeHint: login?.deviceCode
      ? "On the page, choose the account you want, then enter the code."
      : `${host ?? providerLabel} opens in your browser. Choose the account you want, then approve.`,
    paste: login?.awaitingCode
      ? {
          label: "Did the page show a code? Paste it here.",
          value: code,
          onChange: setCode,
          onSubmit: () => void submitCode(),
          submitting,
        }
      : null,
    output: login?.output ?? "",
    expectedAccount,
    account: signedInEmail,
    error: phase === "failed" && !login ? null : error,
    failure: phase === "failed"
      ? {
          title: !login && error ? "The sign-in could not start." : login?.state === "cancelled" ? "The sign-in was stopped." : "Sign-in did not complete.",
          detail: !login && error
            ? error
            : login?.message ?? `ADE found no working login for ${accountName}. ${providerLabel} saves it only after you approve in the browser.`,
          stopped: login?.state === "cancelled",
          extra: existingInstance ? (
            <span className="ade-sis-hint">
              Now: {[existingInstance.account?.email, accountIdentityLine(existingInstance)].filter(Boolean).join(" · ")}
            </span>
          ) : null,
        }
      : null,
    form: (
      <Banner
        layout="inline"
        model={{
          id: "account-sign-in-hint",
          tone: "neutral",
          icon: <ShieldCheck size={15} />,
          title: "Your other accounts stay signed in",
          detail: `Next, ${providerLabel} opens its sign-in page in your browser. Pick ${expectedEmail ?? "the account you want"} there before you approve. The account shows as its email once signed in, and its login is saved for it only.`,
        }}
      />
    ),
  };

  return (
    <SignInSheetFrame
      providerId={provider}
      providerLabel={providerLabel}
      title={title}
      machine={{ pin, isThisMachine, machineName }}
      view={view}
      onClose={close}
      onTryAgain={tryAgain}
      onKeep={close}
      continueAction={{ label: busy ? "Starting…" : "Continue to sign-in", onClick: () => void startCreate(), disabled: busy }}
      closeLabel="Close add account"
    />
  );
}

/** What the account sheet opens on: an existing account, or a new one, optionally meant for one login. */
export type AccountSignInTarget = { existing: ProviderInstance | null; email?: string };

/**
 * Hosts the account sheet for one provider on the Settings page's machine
 * (`useSettingsMachineScope`; first setup provides the same scope): `open`
 * shows it, `element` goes anywhere in the tree. `onChanged` runs after a
 * close that wrote something.
 */
export function useAccountSignInSheet({
  provider,
  providerLabel,
  onChanged,
}: {
  provider: ProviderInstanceProvider;
  providerLabel: string;
  /** `signedIn` is true only when the sign-in succeeded. */
  onChanged: (signedIn: boolean) => void;
}): { open: (target: AccountSignInTarget) => void; element: React.ReactNode } {
  const { pin, isThisMachine, machineName } = useSettingsMachineScope();
  const [target, setTarget] = useState<AccountSignInTarget | null>(null);
  const element = target ? (
    <AccountSignInSheet
      // A new target is a new sheet, never the old one's state.
      key={target.existing?.id ?? `new:${target.email ?? ""}`}
      provider={provider}
      providerLabel={providerLabel}
      existingInstance={target.existing}
      expectedEmail={target.email}
      pin={pin}
      isThisMachine={isThisMachine}
      machineName={machineName}
      onClose={(changed, signedIn) => {
        setTarget(null);
        if (changed) onChanged(signedIn === true);
      }}
    />
  ) : null;
  return { open: setTarget, element };
}

// ─────────────────────────────────────────────────────────────────────────────
// The agent CLIs ADE signs in headlessly
// ─────────────────────────────────────────────────────────────────────────────

type CliPhase = "form" | "signing" | "success" | "failed";

function cliStartFailure(err: unknown): string {
  if (isUnsupportedAdeActionError(err)) {
    return "That machine runs an older ADE that cannot sign in here. Update ADE there, or sign in from its Settings.";
  }
  return providerActionMessage(err, "That sign-in could not be started.");
}

export type CliSignInSheetProps = SignInMachine & {
  provider: AgentCliLoginProvider;
  providerLabel: string;
  /** The account the machine named before this sign-in, when it names one. */
  expectedAccount?: string | null;
  /** Called on every close. `changed` once a sign-in ended (either way); `signedIn` only when it worked. */
  onClose: (changed: boolean, signedIn?: boolean) => void;
};

/**
 * Sign in to an agent CLI ADE runs from its own copy. The machine that owns
 * the CLI runs its login in a private PTY (`ai.cliLoginStart`, routed by
 * `pin`) and reports the link, a device code, and whether it waits for a
 * pasted code. The sheet polls the status and closes once that machine reads
 * the provider's saved login back.
 */
export function CliSignInSheet({ provider, providerLabel, pin, isThisMachine, machineName, expectedAccount = null, onClose }: CliSignInSheetProps) {
  const needsRegion = provider === "kimi";
  const [phase, setPhase] = useState<CliPhase>(needsRegion ? "form" : "signing");
  const [region, setRegion] = useState<KimiLoginRegion>("global");
  const [login, setLogin] = useState<AgentCliLoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** A pasted code went in: the CLI is checking it. */
  const [codeSent, setCodeSent] = useState(false);
  /** Status reads failed in a row; a new one is tried until STATUS_READ_RETRIES. */
  const [failedReads, setFailedReads] = useState(0);

  /** The machine the current sign-in runs on, fixed when it starts: its polls, code and cancel go there. */
  const pinRef = useRef(pin);
  const loginRef = useRef<AgentCliLoginStatus | null>(null);
  const startSeqRef = useRef(0);
  const changedRef = useRef(false);
  const signedInRef = useRef(false);
  const closedRef = useRef(false);
  const aliveRef = useRef(true);
  const openedRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const cancelOnHost = useCallback((target: AgentCliLoginStatus | null) => {
    if (target && isProviderLoginLive(target)) {
      void window.ade?.ai?.cliLoginCancel?.({ loginId: target.loginId }, pinRef.current).catch(() => undefined);
    }
  }, []);

  // A sign-in left running behind a closed sheet would hold the CLI open on
  // its machine until the timeout.
  useEffect(() => () => cancelOnHost(loginRef.current), [cancelOnHost]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current(changedRef.current, signedInRef.current);
  }, []);

  const applyLogin = useCallback((next: AgentCliLoginStatus) => {
    loginRef.current = next;
    if (!aliveRef.current) {
      cancelOnHost(next);
      return;
    }
    setLogin(next);
    // A device flow's page can be opened anywhere: open it in the browser in
    // front of the person, unless the CLI already opens one on this computer.
    if (next.url && next.state === "running" && openedRef.current !== next.loginId) {
      const cliOpensItHere = next.opensBrowser && isThisMachine && !isWebClientMode();
      openedRef.current = next.loginId;
      if (!cliOpensItHere) void window.ade?.app?.openExternal?.(next.url);
    }
    if (next.state === "succeeded") {
      changedRef.current = true;
      signedInRef.current = true;
      setPhase("success");
    } else if (next.state === "failed" || next.state === "cancelled") {
      changedRef.current = true;
      setPhase("failed");
    }
  }, [cancelOnHost, isThisMachine]);

  const start = useCallback(async () => {
    const begin = window.ade?.ai?.cliLoginStart;
    if (!begin) {
      setError("This window cannot run that sign-in. Update ADE, or sign in from a terminal.");
      setPhase("failed");
      return;
    }
    const seq = ++startSeqRef.current;
    cancelOnHost(loginRef.current);
    pinRef.current = pin;
    setError(null);
    setCode("");
    setCodeSent(false);
    setLogin(null);
    setFailedReads(0);
    loginRef.current = null;
    setPhase("signing");
    try {
      const next = await begin({ provider, ...(needsRegion ? { kimiRegion: region } : {}) }, pinRef.current);
      if (seq !== startSeqRef.current) {
        cancelOnHost(next);
        return;
      }
      applyLogin(next);
    } catch (err) {
      if (!aliveRef.current || seq !== startSeqRef.current) return;
      setError(cliStartFailure(err));
      setPhase("failed");
    }
  }, [applyLogin, cancelOnHost, needsRegion, pin, provider, region]);

  // Everything but Kimi (which asks for its region first) starts on open.
  const startedRef = useRef(false);
  useEffect(() => {
    if (needsRegion || startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [needsRegion, start]);

  useEffect(() => {
    if (!login || !isProviderLoginLive(login)) return;
    const read = window.ade?.ai?.cliLoginStatus;
    if (!read) return;
    const loginId = login.loginId;
    const timer = window.setTimeout(() => {
      void read({ loginId }, pinRef.current)
        .then((next) => {
          setFailedReads(0);
          applyLogin(next);
        })
        .catch((err) => {
          if (!aliveRef.current) return;
          // The machine forgot the sign-in: no retry brings it back.
          const gone = err instanceof Error && /no longer running/i.test(err.message);
          if (!gone && failedReads + 1 < STATUS_READ_RETRIES) {
            setFailedReads((count) => count + 1);
            return;
          }
          setError(providerActionMessage(err, "Lost track of that sign-in."));
          setPhase("failed");
        });
    }, STATUS_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [applyLogin, failedReads, login]);

  const submitCode = useCallback(async () => {
    const current = loginRef.current;
    const send = window.ade?.ai?.cliLoginSubmitCode;
    if (!send || !current || !code.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      applyLogin(await send({ loginId: current.loginId, code: code.trim() }, pinRef.current));
      setCode("");
      setCodeSent(true);
    } catch (err) {
      if (aliveRef.current) setError(providerActionMessage(err, "That code was not accepted."));
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }, [applyLogin, code]);

  // After a pasted code the CLI checks it.
  const verifying = login?.state === "verifying" || (codeSent && login?.state === "running" && !login.awaitingCode);
  const host = linkHost(login?.url ?? null);
  const signedInAs = login?.email?.trim() || null;
  const wrongAccount = phase === "success" && signInAccountMismatch(expectedAccount, signedInAs);
  const stage: SignInStage = phase === "form"
    ? "form"
    : phase === "success"
      ? wrongAccount ? "mismatch" : "done"
      : phase === "failed"
        ? "failed"
        : verifying
          ? "verifying"
          : !login || login.downloading || (!login.url && !login.awaitingCode && !login.deviceCode)
            ? "starting"
            : "waiting";
  useSuccessHold(stage, close);

  const view: SignInSheetView = {
    stage,
    startHint: !login
      ? null
      : login.downloading
        ? login.downloading
        : `Waiting for ${providerLabel}'s sign-in link…`,
    url: login?.url ?? null,
    deviceCode: login?.deviceCode ?? null,
    codeHint: login?.deviceCode
      ? `On ${host ?? "the sign-in page"}, check that it shows this code, then approve.`
      : login?.awaitingCode
        ? `${host ?? "The sign-in page"} shows a code once you approve. Paste it below.`
        : `${host ?? providerLabel} opens in your browser. Sign in, then approve.`,
    paste: login?.awaitingCode
      ? {
          label: "Paste the code from the sign-in page",
          value: code,
          onChange: setCode,
          onSubmit: () => void submitCode(),
          submitting,
        }
      : null,
    output: login?.output ?? "",
    expectedAccount,
    account: signedInAs,
    error: phase === "failed" ? null : error,
    failure: phase === "failed"
      ? !login
        ? { title: "The sign-in could not start.", detail: error }
        : {
            title: login.state === "cancelled" ? "The sign-in was stopped." : "Sign-in did not complete.",
            detail: error ?? login.message ?? `ADE found no working ${providerLabel} login. It saves one only after you approve in the browser.`,
            stopped: login.state === "cancelled",
          }
      : null,
    form: needsRegion ? (
      <div className="ade-sis-form">
        <span className="ade-sis-form-label">Which Kimi do you sign in to?</span>
        <div role="radiogroup" aria-label="Kimi region" style={{ display: "flex", gap: 8 }}>
          {KIMI_REGIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={region === entry.id}
              onClick={() => setRegion(entry.id)}
              style={{
                ...outlineButton({ height: 48, padding: "0 14px", fontSize: 12 }),
                flex: 1,
                flexDirection: "column",
                alignItems: "flex-start",
                justifyContent: "center",
                gap: 2,
                borderColor: region === entry.id ? COLORS.accent : undefined,
              }}
            >
              <span style={{ fontWeight: 600 }}>{entry.label}</span>
              <span style={{ fontSize: 11, color: COLORS.textMuted }}>{entry.hint}</span>
            </button>
          ))}
        </div>
      </div>
    ) : null,
  };

  return (
    <SignInSheetFrame
      providerId={CLI_BRAND[provider]}
      providerLabel={providerLabel}
      title={`Sign in to ${providerLabel}`}
      machine={{ pin, isThisMachine, machineName }}
      view={view}
      onClose={close}
      onTryAgain={() => void start()}
      onKeep={close}
      continueAction={{ label: "Continue to sign-in", onClick: () => void start() }}
    />
  );
}

/**
 * Hosts the CLI sheet for one provider: `open()` shows it, `element` goes
 * anywhere in the tree. `onChanged` runs after a close that ended a sign-in,
 * with whether it succeeded. `expectedAccount` is read when the sheet opens.
 */
export function useAgentCliSignInSheet({
  provider,
  providerLabel,
  pin,
  isThisMachine,
  machineName,
  expectedAccount = null,
  onChanged,
}: Omit<CliSignInSheetProps, "onClose"> & { onChanged: (signedIn: boolean) => void }): { open: () => void; element: React.ReactNode } {
  const [openCount, setOpenCount] = useState(0);
  const [shown, setShown] = useState<{ expected: string | null } | null>(null);
  const expectedRef = useRef(expectedAccount);
  expectedRef.current = expectedAccount;
  const open = useCallback(() => {
    setOpenCount((count) => count + 1);
    // The account the machine named before this sign-in; the status read
    // after it may already name the new one.
    setShown({ expected: expectedRef.current });
  }, []);
  const element = shown ? (
    <CliSignInSheet
      key={openCount}
      provider={provider}
      providerLabel={providerLabel}
      pin={pin}
      isThisMachine={isThisMachine}
      machineName={machineName}
      expectedAccount={shown.expected}
      onClose={(changed, signedIn) => {
        setShown(null);
        if (changed) onChanged(signedIn === true);
      }}
    />
  ) : null;
  return { open, element };
}

/**
 * Settings' "Sign in to …" for one CLI, on the machine the page shows
 * (`useSettingsMachineScope().pin`). `fallback` is what an older host gets
 * instead (the terminal login or the command to run).
 */
export function SettingsAgentCliSignIn({
  ctx,
  provider,
  providerLabel,
  fallback,
  again = false,
  offered = true,
}: {
  ctx: ProvidersViewContext;
  provider: AgentCliLoginProvider;
  providerLabel: string;
  fallback: React.ReactNode;
  /** Already signed in: a quieter "Sign in again", to switch accounts or renew the login. */
  again?: boolean;
  /**
   * False: no button, only the sheet's host. Rendered in the button's place
   * once a status refresh says signed in, so an open sheet is not unmounted
   * (which cancels its sign-in) before it shows the result.
   */
  offered?: boolean;
}) {
  const { pin, isThisMachine, machineName } = useSettingsMachineScope();
  const refreshStatus = ctx.actions.refreshStatus;
  const sheet = useAgentCliSignInSheet({
    provider,
    providerLabel,
    pin,
    isThisMachine,
    machineName,
    expectedAccount: ctx.status?.providerConnections?.[provider]?.accountEmail ?? null,
    // A sign-in that worked gets the provider's own check (which reads the
    // status again after); one that did not only reads the status again.
    onChanged: (signedIn) => void (signedIn ? ctx.actions.verifySignIn(provider) : refreshStatus({ force: true, silent: true })),
  });
  if (!agentCliSignInSupported()) return <>{fallback}</>;
  if (!offered) return <>{sheet.element}</>;
  const where = isThisMachine ? "this computer" : machineName;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={sheet.open}
        style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12, alignSelf: "flex-start", ...(again ? { opacity: 0.85 } : {}) })}
      >
        <SignIn size={13} /> {again ? "Sign in again" : `Sign in to ${providerLabel}`}
      </button>
      <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
        {again
          ? `Runs ${providerLabel}'s own sign-in again on ${where}, to switch accounts or renew the login. The new login replaces the one it has now.`
          : `Runs ${providerLabel}'s own sign-in with ADE's copy on ${where} (downloading it first if needed). You approve in the browser, and ${providerLabel} keeps the login in its usual place.`}
      </div>
      {sheet.element}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A login command in a terminal (Qwen; the CLIs on an older ADE)
// ─────────────────────────────────────────────────────────────────────────────

const URL_PATTERN = /https?:\/\/[^\s"'<>()\]]+/g;

/**
 * The first sign-in URL in some terminal output, if there is one. Narrow on
 * purpose: a login prints one link worth opening, and opening a docs link or
 * an update notice would take over the browser for nothing.
 */
function findSignInUrl(text: string): string | null {
  const matches = text.match(URL_PATTERN);
  if (!matches?.length) return null;
  for (const raw of matches) {
    const url = raw.replace(/[.,;:]+$/, "");
    if (/(auth|login|oauth|device|verify|activate|connect|sso)/i.test(url)) return url;
  }
  return null;
}

export type TerminalSignInSheetProps = SignInMachine & {
  providerId: string;
  providerLabel: string;
  /** The command the terminal runs, e.g. `qwen --auth-type=openai`. */
  command: string;
  /** `shell` by default; Muse passes `muse` so the PTY host swaps its pinned binary in. */
  toolType?: TerminalToolType;
  /** Lane to open the terminal in; null asks for the primary lane. */
  laneId?: string | null;
  /** Re-read the saved login. Resolves true once this provider is signed in. */
  checkSignedIn: () => Promise<boolean>;
  onClose: () => void;
  /** Called once, after a successful sign-in. */
  onSignedIn?: () => void;
};

/**
 * A provider whose login is a terminal flow ADE does not run headlessly: a
 * real PTY running the vendor's own login command on the sheet's machine,
 * in step 2. The first sign-in URL it prints opens in a browser once; the
 * saved login is re-read while it runs, and the sheet closes a beat after it
 * turns up. Closing always disposes the PTY.
 */
export function TerminalSignInSheet({
  providerId,
  providerLabel,
  command,
  toolType = "shell",
  laneId,
  checkSignedIn,
  onClose,
  onSignedIn,
  pin,
  isThisMachine,
  machineName,
}: TerminalSignInSheetProps) {
  // Effects key on the pin's identity, not the object: a rebuilt pin with the
  // same key must not restart the login shell.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinIdentity = pin?.key ?? null;
  const [terminal, setTerminal] = useState<{ ptyId: string; sessionId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const openedUrlRef = useRef<string | null>(null);
  const terminalRef = useRef<{ ptyId: string; sessionId: string } | null>(null);
  const closedRef = useRef(false);
  const title = `Sign in to ${providerLabel}`;

  // Open the PTY.
  useEffect(() => {
    let cancelled = false;
    const target = pinRef.current;
    // A new machine gets a new login shell; the old one's terminal is gone.
    setTerminal(null);
    openedUrlRef.current = null;
    setUrl(null);
    void (async () => {
      try {
        if (!window.ade?.pty?.create) throw new Error("Terminals are not available in this window.");
        const lanes = await window.ade.lanes.list({ includeArchived: false, includeStatus: false }, target);
        const resolvedLaneId = laneId ?? lanes.find((lane) => lane.laneType === "primary")?.id ?? lanes[0]?.id ?? null;
        if (!resolvedLaneId) throw new Error("No lane is available to run the login in.");
        const created = await window.ade.pty.create({
          laneId: resolvedLaneId,
          cols: 100,
          rows: 24,
          title,
          // Not tracked: a one-shot login shell, not an agent session; tracking
          // it would put a phantom row in Work.
          tracked: false,
          toolType,
          startupCommand: command,
        }, target);
        if (cancelled) {
          void window.ade.pty.dispose({ ptyId: created.ptyId, sessionId: created.sessionId }, target);
          return;
        }
        terminalRef.current = { ptyId: created.ptyId, sessionId: created.sessionId };
        setTerminal({ ptyId: created.ptyId, sessionId: created.sessionId });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [command, laneId, pinIdentity, title, toolType]);

  // Dispose on unmount, always.
  useEffect(() => {
    const target = pinRef.current;
    return () => {
      const open = terminalRef.current;
      terminalRef.current = null;
      if (open) void window.ade?.pty?.dispose({ ptyId: open.ptyId, sessionId: open.sessionId }, target);
    };
  }, [pinIdentity]);

  // Open the first sign-in URL it prints, once.
  useEffect(() => {
    if (!terminal || !window.ade?.pty?.onData) return;
    const target = pinRef.current;
    const unsubscribe = window.ade.pty.onData((event) => {
      if (event.ptyId !== terminal.ptyId) return;
      if (openedUrlRef.current) return;
      const found = findSignInUrl(event.data ?? "");
      if (!found) return;
      openedUrlRef.current = found;
      setUrl(found);
      openExternalUrl(found);
    }, target);
    return unsubscribe;
  }, [pinIdentity, terminal]);

  // Watch for the saved login.
  // Read through refs: a caller's inline function must not restart the timer.
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  const checkSignedInRef = useRef(checkSignedIn);
  checkSignedInRef.current = checkSignedIn;
  useEffect(() => {
    if (!terminal || signedIn) return;
    let stopped = false;
    const timer = setInterval(() => {
      void checkSignedInRef.current()
        .then((ok) => {
          if (stopped || !ok) return;
          setSignedIn(true);
          onSignedInRef.current?.();
        })
        .catch(() => {
          // A failed re-read is not a failed login. Keep watching.
        });
    }, TERMINAL_AUTH_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [signedIn, terminal]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  }, [onClose]);

  const stage: SignInStage = error ? "failed" : signedIn ? "done" : terminal ? "waiting" : "starting";
  useSuccessHold(stage, close);

  const view: SignInSheetView = {
    stage,
    startHint: "Starting a terminal…",
    url,
    deviceCode: null,
    approveLabel: "Finish in the terminal",
    codeHint: url ? "Not in your browser? Click Open sign-in page." : null,
    stepExtra: terminal ? (
      <>
        <span className="ade-sis-hint">
          ADE runs <code>{command}</code> here. Answer its questions; the sheet closes once you are signed in.
        </span>
        {/*
          A definite height, not just a min-height: TerminalView fills its
          parent with `h-full`, which is 0 against a box sized only by
          min-height, and a 0-height host never subscribes to its PTY.
        */}
        <div className="ade-sis-terminal">
          <TerminalView
            key={`${providerId}:${terminal.sessionId}`}
            ptyId={terminal.ptyId}
            sessionId={terminal.sessionId}
            runtimePin={pin}
            isActive
            className="h-full w-full"
          />
        </div>
      </>
    ) : null,
    expectedAccount: null,
    account: null,
    failure: error ? { title: "The sign-in could not start.", detail: error } : null,
  };

  return (
    <SignInSheetFrame
      providerId={providerId}
      providerLabel={providerLabel}
      title={title}
      machine={{ pin, isThisMachine, machineName }}
      view={view}
      onClose={close}
      width={720}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Antigravity (its owner keeps the flow)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sheet for an Antigravity sign-in. The Settings page and the setup card
 * each run the flow (`ai.antigravitySignIn*` on their pin); this draws its
 * state. Antigravity names no account, so the note asks the person to check
 * it on Google's page.
 */
export function AntigravitySignInSheetView({
  state,
  starting,
  machine,
  submitting,
  onSubmitAddress,
  onClose,
  onTryAgain,
  error,
}: {
  state: AntigravitySignInState | null;
  /** The start call is in flight (no state for it yet). */
  starting: boolean;
  machine: SignInMachine;
  submitting: boolean;
  /** Hand the address the browser ended on to the agent. */
  onSubmitAddress: (address: string) => void;
  /** Close; the owner stops a running flow first. */
  onClose: () => void;
  onTryAgain?: () => void;
  error?: string | null;
}) {
  const [address, setAddress] = useState("");
  const phase = state?.phase ?? "idle";
  const stage: SignInStage = starting || phase === "starting" || (phase === "idle" && !error)
    ? "starting"
    : phase === "waiting"
      ? "waiting"
      : phase === "verifying"
        ? "verifying"
        : phase === "succeeded"
          ? "done"
          : "failed";
  useSuccessHold(stage, onClose);
  const view: SignInSheetView = {
    stage,
    url: state?.authorizationUrl ?? null,
    deviceCode: null,
    codeHint: machine.isThisMachine
      ? "Google sends the browser back to Antigravity by itself."
      : `Google sends the browser back to an address on ${machine.machineName}, so the last page will not load here. Paste its address below.`,
    paste: state?.acceptsCallbackUrl && isAntigravitySignInRunning(state)
      ? {
          label: machine.isThisMachine
            ? "Signed in with a browser on another computer? Paste the address its last page shows."
            : "The address the browser ended on (it starts with http://127.0.0.1)",
          placeholder: "http://127.0.0.1:…/?state=…&code=…",
          value: address,
          onChange: setAddress,
          onSubmit: () => {
            const value = address.trim();
            if (!value) return;
            setAddress("");
            onSubmitAddress(value);
          },
          submitting,
          submitLabel: "Continue",
        }
      : null,
    stepExtra: state?.licensePickerUrl ? (
      <span className="ade-sis-hint">
        Then choose your license on the page Antigravity serves. It opens only in a browser on {signInMachineWords(machine.isThisMachine, machine.machineName)}: <code>{state.licensePickerUrl}</code>
      </span>
    ) : null,
    expectedAccount: null,
    account: null,
    error: stage === "failed" ? null : error ?? null,
    failure: stage === "failed"
      ? phase === "cancelled"
        ? { title: "The sign-in was stopped.", detail: state?.message ?? null, stopped: true }
        : { title: error && phase !== "failed" ? "The sign-in could not start." : "Sign-in did not complete.", detail: error ?? state?.message ?? null }
      : null,
  };
  return (
    <SignInSheetFrame
      providerId="antigravity"
      providerLabel="Antigravity"
      title="Sign in to Antigravity"
      machine={machine}
      view={view}
      onClose={onClose}
      onTryAgain={onTryAgain}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor (its owner keeps the flow)
// ─────────────────────────────────────────────────────────────────────────────

/** How a Cursor sign-in ended, as its owner reports it. */
export type CursorSignInOutcome = { ok: boolean; email?: string | null; error?: string | null };

/**
 * The sheet for a Cursor sign-in. The owner runs `ai.cursorAuthLogin` on its
 * pin (Settings also checks the new key); this draws where it is.
 */
export function CursorSignInSheetView({
  running,
  verifying,
  loginUrl,
  outcome,
  expectedAccount,
  machine,
  onClose,
  onTryAgain,
}: {
  running: boolean;
  verifying: boolean;
  /** The sign-in page Cursor reported, when the owner knows it. */
  loginUrl: string | null;
  outcome: CursorSignInOutcome | null;
  expectedAccount: string | null;
  machine: SignInMachine;
  onClose: () => void;
  onTryAgain: () => void;
}) {
  const account = outcome?.ok ? outcome.email?.trim() || null : null;
  const stage: SignInStage = outcome
    ? outcome.ok
      ? signInAccountMismatch(expectedAccount, account) ? "mismatch" : "done"
      : "failed"
    : verifying
      ? "verifying"
      : running && loginUrl
        ? "waiting"
        : "starting";
  useSuccessHold(stage, onClose);
  const view: SignInSheetView = {
    stage,
    startHint: running ? "Cursor opens its sign-in page in your browser…" : null,
    url: loginUrl,
    deviceCode: null,
    codeHint: "Sign in on Cursor's page. ADE makes a Cursor key for itself; it does not copy Cursor app cookies.",
    expectedAccount,
    account,
    failure: outcome && !outcome.ok ? { title: "Sign-in did not complete.", detail: outcome.error || "Cursor sign-in failed." } : null,
  };
  return (
    <SignInSheetFrame
      providerId="cursor"
      providerLabel="Cursor"
      title="Sign in to Cursor"
      machine={machine}
      view={view}
      onClose={onClose}
      onTryAgain={onTryAgain}
      onKeep={onClose}
    />
  );
}
