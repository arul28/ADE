import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowsClockwise, LockKey } from "@phosphor-icons/react";
import type {
  AppBundleOwnershipFixResult,
  AppBundleOwnershipStatus,
} from "../../../shared/types/appBundleOwnership";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";
import { Dialog } from "../ui/dialog";
import { showToast } from "./toast/toastStore";
import { CopyableCommand } from "../settings/providers/providerUi";

/** Read the bundle a little after the window settles, never on the boot path. */
const FIRST_CHECK_DELAY_MS = 8_000;
const APP_BANNER = { placement: "docked", priority: APP_BANNER_PRIORITY.app } as const;

/**
 * "ADE will ask for your password on every update": shown when this Mac's
 * ADE.app is not writable by the signed-in user (usually root-owned after one
 * install with admin rights), which makes the macOS updater install as root
 * behind a password prompt, every time. Offers the one-click fix.
 *
 * This computer only: the bundle checked is the one this window runs from, so
 * nothing here takes a remote pin.
 */
export function AppBundleOwnershipBanner(): JSX.Element | null {
  const bridge = typeof window !== "undefined" ? window.ade?.appBundleOwnership : undefined;
  const [status, setStatus] = useState<AppBundleOwnershipStatus | null>(null);
  const [fixing, setFixing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastResult, setLastResult] = useState<AppBundleOwnershipFixResult | null>(null);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void bridge.getStatus().then(
        (next) => {
          if (!cancelled) setStatus(next);
        },
        () => {},
      );
    }, FIRST_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bridge]);

  const runFix = useCallback(() => {
    if (!bridge || fixing) return;
    setFixing(true);
    setLastResult(null);
    setCheckNote(null);
    void bridge.fix().then(
      (result) => {
        setStatus(result.status);
        setLastResult(result);
        if (result.outcome === "fixed") {
          setDetailsOpen(false);
          showToast({ tone: "success", title: "Updates won't ask for your password", message: result.message });
        }
      },
      () => {
        setLastResult(null);
        setCheckNote("ADE couldn't run the fix. Try the Terminal command in Details.");
      },
    ).finally(() => setFixing(false));
  }, [bridge, fixing]);

  const checkAgain = useCallback(() => {
    if (!bridge || checking) return;
    setChecking(true);
    setLastResult(null);
    setCheckNote(null);
    void bridge.getStatus({ refresh: true }).then(
      (next) => {
        setStatus(next);
        if (next.state === "ok") {
          setDetailsOpen(false);
          showToast({ tone: "success", title: "ADE's files belong to your account", message: "Updates won't ask for your password." });
        } else if (next.state === "needs_fix") {
          setCheckNote("Checked again. Your account still can't change some of ADE's files.");
        }
      },
      () => setCheckNote("ADE couldn't check its files."),
    ).finally(() => setChecking(false));
  }, [bridge, checking]);

  const needsFix = status?.state === "needs_fix";
  const failure = lastResult && lastResult.outcome !== "fixed" ? lastResult.message : checkNote;

  useAppBanner(
    needsFix && status
      ? {
          id: "app-bundle-ownership",
          tone: "warning",
          icon: <LockKey size={13} weight="bold" />,
          title: "ADE will ask for your password on every update",
          detail: status.ownerName
            ? "Its app files belong to the administrator account, so macOS can only update it as administrator."
            : "Your account can't change its app files, so macOS can only update it as administrator.",
          actions: [
            {
              label: fixing ? "Fixing…" : "Fix it",
              variant: "primary",
              busy: fixing,
              disabled: fixing,
              onClick: runFix,
            },
            { label: "Details", variant: "secondary", onClick: () => setDetailsOpen(true) },
          ],
          ...(failure && !detailsOpen ? { error: failure } : {}),
          // Keyed on the version: dismissed, it comes back after the next
          // update if the files are still not the user's.
          dismiss: { key: "app-bundle-ownership", fingerprint: status.appVersion ?? "unknown" },
        }
      : null,
    APP_BANNER,
  );

  if (!needsFix || !status) return null;
  const bundlePath = status.bundlePath ?? "/Applications/ADE.app";
  return (
    <Dialog
      open={detailsOpen}
      onOpenChange={setDetailsOpen}
      title="Why ADE asks for your password on every update"
      tone="warning"
      icon={<LockKey size={16} weight="fill" />}
      size="sm"
      width={480}
      actions={[
        {
          label: checking ? "Checking…" : "Check again",
          icon: <ArrowsClockwise size={12} weight="bold" />,
          variant: "secondary",
          busy: checking,
          disabled: checking || fixing,
          onClick: checkAgain,
        },
        {
          label: fixing ? "Fixing…" : "Fix it",
          variant: "solid",
          autoFocus: true,
          busy: fixing,
          disabled: fixing || checking,
          onClick: runFix,
        },
      ]}
    >
      <div style={{ display: "grid", gap: 10, fontSize: 12.5, lineHeight: 1.5 }}>
        <Section title="What happened">
          {status.ownerName ? (
            <>
              ADE's app files at <code>{bundlePath}</code> belong to{" "}
              {status.ownerName === "root" ? "the system administrator account (root)" : status.ownerName}, not to you.
              This usually comes from one install or update done with admin rights.
            </>
          ) : (
            <>Your account can't change ADE's app files at <code>{bundlePath}</code>.</>
          )}
        </Section>
        <Section title="Why it keeps happening">
          macOS can only update an app as you when your account owns it. Otherwise the updater installs as
          administrator, asks for your password, and the new copy belongs to the administrator again, so the next
          update asks too.
        </Section>
        <Section title="What Fix it does">
          It asks for your password once and gives ADE's files back to your account. Nothing else on this Mac
          changes, and ADE keeps running.
        </Section>
        {status.parentWritable === false ? (
          <p style={{ margin: 0, color: "var(--color-warning)" }}>
            Your account also can't write to the folder ADE is in, so updates may still ask for a password after the
            fix. Moving ADE to a folder you can write to solves that.
          </p>
        ) : null}
        {status.manualCommand ? (
          <div style={{ display: "grid", gap: 4 }}>
            <span style={{ fontWeight: 600, color: "var(--color-fg)" }}>Or run this in Terminal</span>
            <CopyableCommand command={status.manualCommand} />
          </div>
        ) : null}
        {failure ? (
          <p role="status" style={{ margin: 0, color: "var(--color-warning)" }}>{failure}</p>
        ) : null}
      </div>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <p style={{ margin: 0, fontWeight: 600, color: "var(--color-fg)" }}>{title}</p>
      <p style={{ margin: "2px 0 0" }}>{children}</p>
    </div>
  );
}
