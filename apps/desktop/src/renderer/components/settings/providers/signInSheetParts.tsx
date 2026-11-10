/**
 * The parts of every provider sign-in, in the three places one runs: the
 * Settings and first-setup sheet (`ProviderSignInSheet`), the chat card that
 * takes the prompt box's place (`chat/ProviderSignInCard`), and the inline
 * sign-ins of Pi and OpenCode. Each place owns its flow, its machine (pin)
 * and its words; these only draw them, so thirteen providers look like one.
 *
 * The parts: the banner (logo, "Sign in to …", the computer), the account
 * note, the three steps, the code with its page button and QR, the paste box,
 * the raw output, and the end states (signed in, the wrong account, failed).
 */
import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowSquareOut, CaretRight, Check, CheckCircle, Copy, QrCode, UserFocus, Warning, WarningCircle, X } from "@phosphor-icons/react";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { AdeQrCodeTile } from "../../ui/AdeQrCode";
import { DialogTitle } from "../../ui/dialog";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { isImeComposing } from "../../../lib/imeComposition";
import { providerBrand } from "./providerBrand";
import { SolidLogo } from "./ProviderHero";
import { CopyReportButton } from "./providerUi";
import "./signInSheet.css";

/** The sign-in link's host ("claude.ai"), or null when there is no usable link. */
export function linkHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Where one sign-in is. `form` asks a question first (Kimi's region, an
 * account to add, Antigravity's method); `mismatch` is a finished sign-in to
 * an account other than the one ADE expected.
 */
export type SignInStage = "form" | "starting" | "waiting" | "verifying" | "done" | "mismatch" | "failed";

/** True while the sign-in runs on its machine (a close stops it there). */
export function signInRunning(stage: SignInStage): boolean {
  return stage === "starting" || stage === "waiting" || stage === "verifying";
}

/**
 * True when the sign-in finished on another account than the one ADE knew
 * before it started. Both must be known: ADE never guesses an account.
 */
export function signInAccountMismatch(expected: string | null | undefined, actual: string | null | undefined): boolean {
  const a = expected?.trim().toLowerCase();
  const b = actual?.trim().toLowerCase();
  return Boolean(a && b && a !== b);
}

/** The words for where the sign-in runs: nothing for this computer, "on <name>" for another. */
export function signInPlace(isThisMachine: boolean, machineName: string): string | null {
  return isThisMachine ? null : `on ${machineName}`;
}

/**
 * The machine as words inside a sentence: "this computer" for the local one
 * (its stored name "This computer" would put a capital in mid-sentence), else
 * its own name.
 */
export function signInMachineWords(isThisMachine: boolean, machineName: string): string {
  return isThisMachine ? "this computer" : machineName;
}

// ── Logo and banner ──

/** The provider's logo as it stands on its banner; `turn` spins it once (the success moment). */
export function SignInBrandLogo({ providerId, size, turn = false }: { providerId: string; size: number; turn?: boolean }) {
  const brand = providerBrand(providerId);
  return (
    <span className="ade-sis-logo" data-turn={turn ? "true" : undefined} style={{ width: size + 14, height: size + 14 }}>
      {brand.logo.kind === "solid" ? (
        <SolidLogo spec={{ ...brand.logo, size }} straight />
      ) : (
        <span className="ade-sis-logo-tile" style={{ background: brand.logo.background, color: brand.logo.color, width: size + 10, height: size + 10 }}>
          <ProviderLogo family={providerId} size={size - 4} />
        </span>
      )}
    </span>
  );
}

/**
 * The top of the sheet: the provider's banner, logo, title and the computer it
 * runs on. Only inside a `Dialog` with `hideHeader` and `titleInBody`: its
 * heading is the dialog's title.
 */
export function SignInBanner({
  providerId,
  title,
  place,
  turn,
  onClose,
  closeLabel,
}: {
  providerId: string;
  title: React.ReactNode;
  /** "on Mac Studio", or null on this computer. */
  place: string | null;
  turn: boolean;
  onClose: () => void;
  closeLabel: string;
}) {
  const brand = providerBrand(providerId);
  return (
    <div className="ade-sis-banner" data-light={brand.lightBanner ? "true" : undefined} style={brand.banner}>
      {brand.bannerArt ? (
        <img
          className="ade-sis-banner-art"
          src={brand.bannerArt.src}
          alt=""
          draggable={false}
          style={{ opacity: brand.bannerArt.opacity ?? 1 }}
        />
      ) : null}
      <div className="ade-sis-banner-shade" aria-hidden />
      <SignInBrandLogo providerId={providerId} size={34} turn={turn} />
      <div className="ade-sis-heading">
        <DialogTitle asChild>
          <h2 className="ade-sis-title">{title}</h2>
        </DialogTitle>
        {place ? <span className="ade-sis-place">{place}</span> : null}
      </div>
      <button type="button" className="ade-sis-close" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
        <X size={13} weight="bold" />
      </button>
    </div>
  );
}

// ── The account note ──

/**
 * Which account to approve. The browser can be signed in to another account
 * than the one this sign-in is for, and the provider's page names it.
 */
export function SignInAccountNote({ providerLabel, expectedAccount }: { providerLabel: string; expectedAccount: string | null | undefined }) {
  const account = expectedAccount?.trim() || null;
  return (
    <div className="ade-sis-note" role="note">
      <UserFocus size={14} weight="bold" />
      <span>
        {account ? (
          <>
            Sign in as <b>{account}</b>. Your browser can be on another account. Check the name on {providerLabel}'s page before you approve.
          </>
        ) : (
          <>Check the account on {providerLabel}'s page before you approve.</>
        )}
      </span>
    </div>
  );
}

// ── Steps ──

type StepState = "done" | "active" | "waiting" | "failed";

/** The state of each of the three steps for a stage. */
function signInStepStates(stage: SignInStage): [StepState, StepState, StepState] {
  switch (stage) {
    case "starting":
      return ["active", "waiting", "waiting"];
    case "waiting":
      return ["done", "active", "waiting"];
    case "verifying":
      return ["done", "done", "active"];
    case "done":
    case "mismatch":
      return ["done", "done", "done"];
    default:
      return ["waiting", "waiting", "waiting"];
  }
}

/**
 * 1 "ADE started the sign-in", 2 "Approve in your browser", 3 "ADE checks
 * the sign-in". `children` is what step 2 needs (the code, the page, the
 * paste box); it shows while step 2 is the one to do.
 */
export function SignInSteps({
  stage,
  approveLabel = "Approve in your browser",
  startHint,
  children,
}: {
  stage: SignInStage;
  /** Step 2's words when there is no browser (a terminal sign-in). */
  approveLabel?: string;
  /** A short line beside step 1 while it runs ("Getting Kimi ready…"). */
  startHint?: string | null;
  children?: React.ReactNode;
}) {
  const [one, two, three] = signInStepStates(stage);
  const steps: Array<{ state: StepState; label: string; hint?: string | null; body?: React.ReactNode }> = [
    { state: one, label: "ADE started the sign-in", hint: one === "active" ? startHint ?? null : null },
    { state: two, label: approveLabel, body: two === "active" ? children : null },
    { state: three, label: "ADE checks the sign-in" },
  ];
  return (
    <ol className="ade-sis-steps" aria-label="Sign-in steps">
      {steps.map((step, index) => (
        <li
          key={step.label}
          className="ade-sis-step"
          data-state={step.state}
          aria-current={step.state === "active" ? "step" : undefined}
        >
          <span className="ade-sis-step-mark" aria-hidden>
            {step.state === "done" ? <Check size={11} weight="bold" /> : index + 1}
          </span>
          <span className="ade-sis-step-label">
            {step.label}
            {step.hint ? <span className="ade-sis-step-hint">{step.hint}</span> : null}
            <span className="ade-sis-sr-only">
              {step.state === "done" ? " (done)" : step.state === "active" ? " (now)" : ""}
            </span>
          </span>
          {step.body ? <div className="ade-sis-step-body">{step.body}</div> : null}
        </li>
      ))}
    </ol>
  );
}

// ── The code, the page and the QR ──

type OpenUrl = (url: string) => void;

const openWithApp: OpenUrl = (url) => {
  void window.ade?.app?.openExternal?.(url);
};

/**
 * Opens the sign-in page and copies the one-time code first, so the person
 * pastes it on the page. Returns whether a code was copied.
 */
async function openSignInPage(url: string, deviceCode: string | null, open: OpenUrl = openWithApp): Promise<boolean> {
  let copied = false;
  if (deviceCode) {
    try {
      await navigator.clipboard?.writeText(deviceCode);
      copied = true;
    } catch {
      copied = false;
    }
  }
  open(url);
  return copied;
}

/**
 * Enter opens the sign-in page while a page is there, unless the key is for
 * a field or a button the person is on. Listens only while there is a URL.
 * `scopeRef` is any element inside the sheet or card; the key counts only
 * when focus is in the same dialog or card, or on nothing at all.
 */
export function useEnterOpensSignInPage(
  scopeRef: React.RefObject<HTMLElement | null>,
  url: string | null,
  deviceCode: string | null,
  open: OpenUrl = openWithApp,
  onOpened?: (codeCopied: boolean) => void,
): void {
  const latest = useRef({ deviceCode, open, onOpened });
  latest.current = { deviceCode, open, onOpened };
  useEffect(() => {
    if (!url) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (isImeComposing(event)) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, button, a, [contenteditable='true'], [role='button'], .xterm")) return;
      const scope = scopeRef.current;
      const container = scope?.closest("[role='dialog'], [data-sign-in-card]") ?? scope;
      if (target && target !== document.body && !(container?.contains(target))) return;
      event.preventDefault();
      const { deviceCode: code, open: opener, onOpened: done } = latest.current;
      void openSignInPage(url, code, opener).then((copied) => done?.(copied));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scopeRef, url]);
}

/**
 * Step 2's content for a sign-in with a page: the one-time code (click to
 * copy), "Open sign-in page" (which copies the code too), "Copy link", and,
 * for a page with a code, a QR of the link for a phone.
 */
export function SignInCodePanel({
  url,
  deviceCode,
  hint,
  open = openWithApp,
  focusOpen = false,
  codeTestId,
}: {
  url: string | null;
  deviceCode: string | null;
  /** One line under the buttons: what to do on the page. */
  hint?: React.ReactNode;
  open?: OpenUrl;
  /** Put focus on "Open sign-in page" when it appears, so Enter opens it. */
  focusOpen?: boolean;
  /** `data-testid` of the code row. */
  codeTestId?: string;
}) {
  const { copy, isCopied } = useCopyToClipboard();
  const [codeCopiedByOpen, setCodeCopiedByOpen] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const openRef = useRef<HTMLButtonElement | null>(null);
  const host = linkHost(url);
  useEffect(() => {
    if (!focusOpen || !url) return;
    const active = document.activeElement;
    // Never pull focus out of a field the person is typing in.
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    openRef.current?.focus({ preventScroll: true });
  }, [focusOpen, url]);
  if (!url && !deviceCode) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {deviceCode ? (
        <div className="ade-sis-code-row" data-testid={codeTestId}>
          <button
            type="button"
            className="ade-sis-code"
            aria-label={`One-time code ${deviceCode}. Copy it.`}
            title="Copy the code"
            onClick={() => void copy(deviceCode, "code")}
          >
            {deviceCode}
            {isCopied("code") ? <Check size={13} weight="bold" /> : <Copy size={13} />}
          </button>
          {codeCopiedByOpen || isCopied("code") ? <span className="ade-sis-hint">Code copied.</span> : null}
        </div>
      ) : null}
      {url ? (
        <div className="ade-sis-actions">
          <button
            ref={openRef}
            type="button"
            className="ade-sis-button"
            data-primary="true"
            onClick={() => void openSignInPage(url, deviceCode, open).then(setCodeCopiedByOpen)}
          >
            <ArrowSquareOut size={13} /> Open sign-in page
          </button>
          <button type="button" className="ade-sis-button" onClick={() => void copy(url, "link")}>
            {isCopied("link") ? <Check size={13} /> : <Copy size={13} />} {isCopied("link") ? "Copied" : "Copy link"}
          </button>
          {deviceCode ? (
            <button type="button" className="ade-sis-button" aria-pressed={showQr} onClick={() => setShowQr((shown) => !shown)}>
              <QrCode size={13} /> {showQr ? "Hide QR" : "QR"}
            </button>
          ) : null}
        </div>
      ) : null}
      {url && deviceCode && showQr ? (
        <div className="ade-sis-qr">
          <AdeQrCodeTile value={url} title={`Sign-in link for ${host ?? "the sign-in page"}`} size={132} style={{ padding: 10 }} />
          <span className="ade-sis-qr-note">Scan it with your phone to open the page there, then enter the code.</span>
        </div>
      ) : null}
      {hint ? <span className="ade-sis-hint">{hint}</span> : null}
    </div>
  );
}

// ── The paste box ──

/** The field for a code (or an address) the sign-in page shows once the person approves. */
export function SignInPasteBox({
  label,
  placeholder = "Paste the code here",
  value,
  onChange,
  onSubmit,
  submitting = false,
  submitLabel = "Submit",
  autoFocus = false,
  testId,
  submitTestId,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitting?: boolean;
  submitLabel?: string;
  autoFocus?: boolean;
  testId?: string;
  submitTestId?: string;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const disabled = submitting || !value.trim();
  return (
    <div className="ade-sis-paste">
      <label className="ade-sis-paste-label" htmlFor={id}>{label}</label>
      <div className="ade-sis-paste-row">
        <input
          id={id}
          ref={inputRef}
          className="ade-sis-input"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          data-testid={testId}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              if (!disabled) onSubmit();
            }
          }}
        />
        <button type="button" className="ade-sis-button" data-primary="true" disabled={disabled} data-testid={submitTestId} onClick={onSubmit}>
          {submitting ? "Sending…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── The raw output ──

/** The provider's own words, behind a disclosure. Closed by default. */
export function OutputDisclosure({ output }: { output: string }) {
  const [open, setOpen] = useState(false);
  if (!output.trim()) return null;
  return (
    <div>
      <button type="button" className="ade-sis-output-toggle" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}>
        <CaretRight size={10} /> Sign-in output
      </button>
      {open ? <pre className="ade-sis-output">{output.trim()}</pre> : null}
    </div>
  );
}

// ── End states ──

/**
 * "Signed in as you@example.com." `live` false: the caller already wraps it in
 * a live region (one region, never one inside another).
 */
export function SignInSuccess({ account, providerLabel, live = true }: { account: string | null | undefined; providerLabel: string; live?: boolean }) {
  const name = account?.trim() || null;
  return (
    <div className="ade-sis-end" data-tone="ok" role={live ? "status" : undefined}>
      <CheckCircle size={18} weight="fill" />
      <span className="ade-sis-end-text">
        <span className="ade-sis-end-title">{name ? `Signed in as ${name}.` : `Signed in to ${providerLabel}.`}</span>
      </span>
    </div>
  );
}

/**
 * The sign-in finished on another account than the one ADE expected: "This
 * is B, not A", then Keep B or Try again. The new login is already saved;
 * Keep accepts it, Try again runs the sign-in once more.
 */
export function SignInMismatch({
  expected,
  actual,
  onKeep,
  onTryAgain,
}: {
  expected: string;
  actual: string;
  onKeep: () => void;
  onTryAgain: () => void;
}) {
  return (
    <div className="ade-sis-end" data-tone="crit" role="alert">
      <Warning size={18} weight="fill" />
      <span className="ade-sis-end-text">
        <span className="ade-sis-end-title">This is {actual}, not {expected}.</span>
        <span className="ade-sis-end-detail">The browser approved another account. Keep it, or sign in again with {expected}.</span>
        <span className="ade-sis-actions">
          <button type="button" className="ade-sis-button" data-primary="true" onClick={onTryAgain}>Try again</button>
          <button type="button" className="ade-sis-button" onClick={onKeep}>Keep {actual}</button>
        </span>
      </span>
    </div>
  );
}

/**
 * A failed (or stopped) sign-in: the cause in plain words, and the details
 * for support with every token, code and key taken out
 * (`formatSignInFailureReport`).
 */
export function SignInFailure({
  title,
  detail,
  report,
  tone = "crit",
  live = true,
  children,
}: {
  title: string;
  detail?: string | null;
  /** Null for a sign-in the person stopped: nothing to report. */
  report: string | null;
  tone?: "crit" | "neutral";
  /** False when the caller already wraps it in a live region. */
  live?: boolean;
  /** Extra lines under the cause (the account it had before). */
  children?: React.ReactNode;
}) {
  return (
    <div className="ade-sis-end" data-tone={tone} role={live ? (tone === "crit" ? "alert" : "status") : undefined}>
      <WarningCircle size={18} weight="fill" />
      <span className="ade-sis-end-text" style={{ flex: 1 }}>
        <span className="ade-sis-end-title">{title}</span>
        {detail ? <span className="ade-sis-end-detail">{detail}</span> : null}
        {children}
        {report ? (
          <span style={{ marginTop: 6, maxWidth: 240 }}>
            <CopyReportButton report={report} label="Copy details for support" />
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** The footer's status line while a sign-in runs. */
export function SignInFooterStatus({ children }: { children: React.ReactNode }) {
  return <span className="ade-sis-footer-status" role="status">{children}</span>;
}
