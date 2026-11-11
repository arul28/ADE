/**
 * The frame of the Settings and first-setup sign-in sheets: what a flow shows
 * (`SignInSheetView`), drawn with the shared parts in the shared sheet dialog
 * (`SignInSheetDialog`). Each flow keeps its own file and its own calls:
 * `AccountSignInSheet`, `CliSignInSheet`, `TerminalSignInSheet`, and the
 * Antigravity and Cursor views in `ProviderSignInSheet`.
 */
import React, { useEffect, useMemo, useRef } from "react";
import type { DialogAction } from "../../ui/dialog";
import { Banner } from "../../ui/notice/Banner";
import type { OpenProjectBinding } from "../../../../shared/types";
import { formatSignInFailureReport } from "./providerDiagnosticsReport";
import {
  OutputDisclosure,
  SignInAccountNote,
  SignInCodePanel,
  SignInFailure,
  SignInMismatch,
  SignInPasteBox,
  SignInSheetDialog,
  SignInSteps,
  SignInSuccess,
  signInPlace,
  signInRunning,
  useEnterOpensSignInPage,
  type SignInStage,
} from "./signInSheetParts";

/** How long "Signed in" stays up before the sheet closes itself. */
const SUCCESS_HOLD_MS = 1_600;
/** Status read while a host's sign-in runs (the same 1 s each flow used before). */
export const STATUS_POLL_MS = 1_000;

/** The machine one sheet signs in on. `pin` is null for the tab's own machine. */
export type SignInMachine = {
  pin: OpenProjectBinding | null;
  /** That machine is the computer in front of the person (its browser is this one). */
  isThisMachine: boolean;
  machineName: string;
};

/** What a flow shows; the frame draws it with the shared parts. */
export type SignInSheetView = {
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
  /** The dialog's name, and the header's title. */
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

export function SignInSheetFrame({
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
  const running = signInRunning(view.stage);
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

  return (
    <SignInSheetDialog
      providerId={providerId}
      title={title}
      place={signInPlace(machine.isThisMachine, machine.machineName)}
      turn={view.stage === "done"}
      running={running}
      closeLabel={closeLabel ?? `Close ${providerLabel} sign-in`}
      onClose={onClose}
      footerStatus={footerWords(view)}
      actions={actions}
      width={width}
      rootRef={rootRef}
    >
      {view.error ? (
        <Banner layout="inline" model={{ id: `${providerId}-sign-in-error`, tone: "error", title: view.error }} />
      ) : null}
      {view.stage === "form" ? view.form : null}
      {view.stage === "form" || running ? (
        <SignInAccountNote providerLabel={providerLabel} expectedAccount={view.expectedAccount} />
      ) : null}
      {running || view.stage === "done" ? (
        <SignInSteps stage={view.stage} approveLabel={view.approveLabel} startHint={view.startHint}>
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
    </SignInSheetDialog>
  );
}

/** Close once "Signed in" has been seen, unless the account is the wrong one. */
export function useSuccessHold(stage: SignInStage, close: () => void): void {
  useEffect(() => {
    if (stage !== "done") return;
    const timer = window.setTimeout(close, SUCCESS_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [close, stage]);
}
