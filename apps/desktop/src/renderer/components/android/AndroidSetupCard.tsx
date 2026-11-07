import { useState, type ReactNode } from "react";
import { Check, Minus, PencilSimple, X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidSdkSetupPart, AndroidSdkSetupPlan, AndroidSdkStatus } from "../../../shared/types/androidEmulator";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { Banner } from "../ui/notice";
import { promptDialog } from "../ui/dialog";
import { androidSdkTool } from "./androidDeviceState";
import { AndroidLicenseDialog } from "./AndroidLicenseDialog";
import { formatAndroidBytes } from "../../../shared/androidFormat";
import { androidInstallLine } from "./androidSdkFormat";
import { useAndroidSdkSetup } from "./useAndroidSdkSetup";

/**
 * "Set up Android on this machine" (plan §5 "SDK missing"): a checklist of
 * what a boot needs, each line found or missing with its size, the install
 * folder with a pencil, "Review licences & install", "Use mine…", and the
 * install's progress in the same card. Settings › Android devices shows the
 * same card.
 *
 * Every call goes to the machine the pin names: the card can set up a
 * Windows box from a Mac window. Folder pickers are local, so on another
 * machine the folder is typed instead.
 */

/** Below this, a new device (about 6–8 GB with its data) may not fit. */
const AVD_HOME_LOW_BYTES = 10e9;

const ACCEL_HELP_URL = "https://developer.android.com/studio/run/emulator-acceleration";

type ChecklistRow = {
  id: string;
  label: string;
  /** Null when it cannot be checked yet: acceleration needs the emulator to check it. "working": the install is on it now. */
  ok: boolean | null | "working";
  value: string;
  /** The download size of a missing part, in its own column so a long value never hides it. */
  size?: string | null;
  detail: string | null;
};

/** `API 37 google_apis_playstore` → `API 37 · Google Play`. */
function readableImageVersion(version: string): string {
  return version
    .replace(/\s+google_apis_playstore\b/u, " · Google Play")
    .replace(/\s+google_apis\b/u, " · Google APIs");
}

function partValue(part: AndroidSdkSetupPart): string {
  if (!part.missing && part.installedVersion) {
    return part.id === "system-image" ? readableImageVersion(part.installedVersion) : part.installedVersion;
  }
  // An installed part that is too old: say what changes.
  const target = part.installedVersion && part.version ? `${part.installedVersion} → ${part.version}` : part.version;
  return (part.detail && part.id === "system-image" ? part.detail : target) || "missing";
}

function partSize(part: AndroidSdkSetupPart): string | null {
  return part.missing && part.downloadBytes > 0 ? formatAndroidBytes(part.downloadBytes) : null;
}

/** The rows before the plan arrives (or when Google's repository is unreachable): from the SDK status alone. */
function statusRows(sdk: AndroidSdkStatus): ChecklistRow[] {
  const tool = (id: "platform-tools" | "emulator" | "cmdline-tools" | "system-image", label: string): ChecklistRow => {
    const entry = androidSdkTool(sdk, id);
    return {
      id,
      label,
      ok: entry?.available ?? false,
      value: entry?.available ? entry.version ?? "found" : "missing",
      detail: entry?.available ? null : entry?.detail ?? null,
    };
  };
  return [
    tool("platform-tools", "Platform tools"),
    tool("cmdline-tools", "Command-line tools"),
    tool("emulator", "Emulator"),
    tool("system-image", "Phone image"),
  ];
}

function accelerationRow(sdk: AndroidSdkStatus, plan: AndroidSdkSetupPlan | null): ChecklistRow {
  const accel = plan?.acceleration ?? sdk.acceleration;
  // `emulator -accel-check` answers this, so without the emulator it is unknown, not missing.
  const checkable = androidSdkTool(sdk, "emulator")?.available === true;
  return {
    id: "acceleration",
    label: "Acceleration",
    ok: checkable ? accel.usable : null,
    value: !checkable
      ? "checked after setup"
      : accel.usable ? `${accel.kind ?? "Hypervisor"} on` : accel.kind ? `${accel.kind} off` : "not available",
    detail: checkable && !accel.usable ? accel.detail : null,
  };
}

function RowIcon({ ok }: { ok: ChecklistRow["ok"] }) {
  if (ok === "working") return <span className="flex size-[13px] shrink-0 items-center justify-center text-accent" aria-label="Installing"><Spinner /></span>;
  if (ok) return <Check size={13} weight="bold" aria-label="Found" className="shrink-0 text-success" />;
  if (ok === null) return <Minus size={13} weight="bold" aria-label="Not checked yet" className="shrink-0 text-muted-fg" />;
  return <X size={13} weight="bold" aria-label="Missing" className="shrink-0 text-[var(--color-error)]" />;
}

function Row({ row, trailing }: { row: ChecklistRow; trailing?: React.ReactNode }) {
  return (
    <li
      data-android-setup-row={row.id}
      data-android-setup-ok={row.ok === null ? "unknown" : row.ok === "working" ? "working" : row.ok ? "true" : "false"}
      className="flex min-w-0 flex-col gap-0.5"
    >
      <span className="flex min-w-0 items-center gap-2 font-sans text-xs leading-5">
        <RowIcon ok={row.ok} />
        <span className="w-32 shrink-0 text-fg">{row.label}</span>
        <span className={cn("kit-num min-w-0 flex-1 truncate", row.ok === false || row.ok === "working" ? "text-fg/80" : "text-muted-fg")} title={row.value}>
          {row.value}
        </span>
        {row.size ? <span className="kit-num shrink-0 text-right text-muted-fg">{row.size}</span> : null}
        {trailing}
      </span>
      {row.detail ? (
        <span className="min-w-0 break-words pl-[1.3rem] font-sans text-[11px] leading-4 text-muted-fg">{row.detail}</span>
      ) : null}
    </li>
  );
}

/**
 * The card's buttons: the pane's `Button`, or the `.kit-btn` family on the
 * Settings page so the card sits in its card language (Settings › Apple
 * devices draws with the same kit).
 */
function SetupButton({
  settings,
  variant,
  children,
  ...rest
}: {
  settings: boolean;
  variant: "primary" | "outline" | "ghost";
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
} & Record<`data-${string}`, string>) {
  if (!settings) return <Button variant={variant} size="sm" {...rest}>{children}</Button>;
  const kind = variant === "primary" ? "kit-btn kit-btn-primary" : variant === "ghost" ? "kit-btn kit-btn-ghost" : "kit-btn";
  return <button type="button" className={kind} data-size="sm" {...rest}>{children}</button>;
}

export function AndroidSetupCard({
  sdk,
  pin,
  machineName,
  remoteMachine,
  refreshing,
  onRefresh,
  variant = "pane",
}: {
  sdk: AndroidSdkStatus;
  /** The machine the card sets up; null = the tab's own machine. */
  pin: OpenProjectBinding | null;
  /** Shown when the card sets up another machine. */
  machineName: string | null;
  /** True when that machine is not this computer: folders are typed, not picked. */
  remoteMachine: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  /** `settings` drops the centring wrapper for Settings › Android devices. */
  variant?: "pane" | "settings";
}) {
  const setup = useAndroidSdkSetup(pin, variant === "settings" ? "settings" : "setup-card");
  const inSettings = variant === "settings";
  const { plan, install } = setup;
  const [reviewing, setReviewing] = useState(false);
  const running = install.state === "running";
  const parts = plan?.parts ?? [];
  const required = parts.filter((part) => !part.optional);
  const cli = parts.find((part) => part.id === "android-cli") ?? null;
  const missing = parts.filter((part) => part.missing);
  const somethingMissing = plan ? missing.length > 0 : true;
  const noSpace = plan !== null && plan.diskBytesFree !== null && plan.diskBytesFree < plan.diskBytesNeeded;
  const avdLow = plan !== null && plan.avdHomeFreeBytes !== null && plan.avdHomeFreeBytes < AVD_HOME_LOW_BYTES;
  const canInstall = Boolean(plan && plan.hostSupported && !plan.repositoryError && plan.writable && !noSpace && missing.length > 0 && !running);

  // While an install runs, the parts it finished show a tick and the one it is on a spinner.
  // The installer takes the missing parts in the plan's order.
  const queue = running ? parts.filter((part) => part.missing) : [];
  const partOk = (part: AndroidSdkSetupPart): ChecklistRow["ok"] => {
    if (install.state !== "running" || !part.missing) return !part.missing;
    const at = queue.findIndex((entry) => entry.id === part.id);
    return at < install.partIndex ? true : at === install.partIndex ? "working" : false;
  };

  const rows: ChecklistRow[] = [
    accelerationRow(sdk, plan),
    {
      id: "sdk",
      label: "Android SDK",
      ok: sdk.found,
      value: sdk.found ? sdk.root ?? "found" : "not found",
      detail: null,
    },
    ...(plan && !plan.repositoryError
      ? required.map((part) => ({ id: part.id, label: part.label, ok: partOk(part), value: partValue(part), size: partOk(part) === true ? null : partSize(part), detail: null }))
      : statusRows(sdk)),
  ];

  const pickFolder = async (purpose: "install" | "existing"): Promise<string | null> => {
    const title = purpose === "install" ? "Install the Android SDK in" : "Use the Android SDK in";
    const current = purpose === "install" ? plan?.sdkRoot ?? "" : sdk.root ?? "";
    if (!remoteMachine && window.ade?.project?.chooseDirectory) {
      return window.ade.project.chooseDirectory({ title, defaultPath: current || undefined });
    }
    const typed = await promptDialog({
      title: machineName ? `${title} on ${machineName}` : title,
      message: purpose === "install"
        ? "The full path of a folder on that machine. ADE makes it if it is missing."
        : "The full path of the SDK folder on that machine (it holds platform-tools or emulator).",
      defaultValue: current,
      confirmLabel: purpose === "install" ? "Use folder" : "Use this SDK",
    });
    return typed?.trim() ? typed.trim() : null;
  };

  const changeInstallFolder = async () => {
    const folder = await pickFolder("install");
    if (folder) setup.setChosenRoot(folder);
  };

  const pickOwnSdk = async () => {
    const folder = await pickFolder("existing");
    if (!folder) return;
    if (await setup.useExistingSdk(folder)) onRefresh();
  };

  const body = (
    <div
      className={inSettings ? "ade-as-panel" : "ade-tool-card ade-tool-card-solid flex w-full min-w-0 max-w-md flex-col gap-3 p-5"}
      data-android-setup-card=""
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <p className="min-w-0 flex-1 font-sans text-sm font-medium leading-5 text-fg">
          {!sdk.found ? "Set up Android on this machine" : plan && !somethingMissing ? "Android is ready" : "Finish setting up Android"}
        </p>
        {machineName ? <span className="shrink-0 font-sans text-[11px] text-muted-fg">on {machineName}</span> : null}
        {setup.loading ? <span className="shrink-0 text-muted-fg" aria-label="Checking"><Spinner /></span> : null}
      </div>

      {plan && !plan.hostSupported ? (
        <p className="min-w-0 break-words font-sans text-xs leading-5 text-fg/85">{plan.unsupportedReason}</p>
      ) : null}

      <ul className="flex min-w-0 flex-col gap-1.5" aria-label="What the emulator needs">
        {rows.map((row) => (
          <Row
            key={row.id}
            row={row}
            trailing={row.id === "acceleration" && row.ok === false ? (
              <a href={ACCEL_HELP_URL} target="_blank" rel="noreferrer" className="shrink-0 font-sans text-[11px] text-accent hover:underline">
                How to fix
              </a>
            ) : null}
          />
        ))}
        {cli ? (
          <li data-android-setup-row="android-cli" className="flex min-w-0 items-center gap-2 font-sans text-xs leading-5">
            {cli.installedVersion ? (
              <Check size={13} weight="bold" aria-label="Found" className="shrink-0 text-success" />
            ) : (
              <input
                type="checkbox"
                className="size-[13px] shrink-0"
                aria-label="Also install the Android CLI"
                checked={setup.includeAndroidCli}
                disabled={running || cli.downloadBytes === 0}
                onChange={(event) => setup.setIncludeAndroidCli(event.currentTarget.checked)}
              />
            )}
            <span className="w-32 shrink-0 text-fg">Android CLI</span>
            <span className="kit-num min-w-0 flex-1 truncate text-muted-fg" title={cli.detail ?? undefined}>
              {cli.installedVersion ? cli.installedVersion : cli.detail}
            </span>
            {!cli.installedVersion && cli.downloadBytes > 0 ? (
              <span className="kit-num shrink-0 text-right text-muted-fg">{formatAndroidBytes(cli.downloadBytes)}</span>
            ) : null}
          </li>
        ) : null}
      </ul>

      {plan && somethingMissing && plan.hostSupported ? (
        <div className="flex min-w-0 flex-col gap-1 font-sans text-[11px] leading-4 text-muted-fg">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-fg/80">Installs to</span>
            <span className="min-w-0 truncate font-mono" title={plan.sdkRoot}>{plan.sdkRoot}</span>
            <button
              type="button"
              className="kit-icon-btn shrink-0"
              aria-label="Change the install folder"
              title="Change the install folder"
              disabled={running}
              onClick={() => void changeInstallFolder()}
              data-android-setup-folder=""
            >
              <PencilSimple size={12} />
            </button>
          </span>
          {/* Without Google's manifests the sizes are unknown. */}
          {plan.repositoryError ? null : (
            <span className={cn("kit-num", noSpace && "text-[var(--kit-warn)]")}>
              Needs {formatAndroidBytes(plan.diskBytesNeeded)}
              {plan.diskBytesFree !== null ? ` · ${formatAndroidBytes(plan.diskBytesFree)} free` : ""}
            </span>
          )}
          {plan.avdHome ? (
            <span className={cn("min-w-0 truncate", avdLow && "text-[var(--kit-warn)]")} title={plan.avdHome}>
              Devices go to <span className="font-mono">{plan.avdHome}</span>
              {plan.avdHomeFreeBytes !== null ? <span className="kit-num"> · {formatAndroidBytes(plan.avdHomeFreeBytes)} free</span> : null}
              {avdLow ? " · each device needs about 8 GB" : ""}
            </span>
          ) : null}
        </div>
      ) : null}

      {setup.error ? (
        <Banner
          layout="inline"
          model={{
            id: "android-setup-plan-error",
            tone: "warning",
            title: "Could not read what to install",
            detail: setup.error.sentence,
            error: setup.error.detail ?? undefined,
            actions: [{ label: "Retry", onClick: setup.refresh }],
          }}
        />
      ) : null}
      {plan?.repositoryError ? (
        <Banner
          layout="inline"
          model={{
            id: "android-setup-repository",
            tone: "warning",
            title: "Google's SDK repository is not reachable",
            detail: "Check this machine's internet connection, then retry. You can also use an SDK you already have.",
            error: plan.repositoryError,
            actions: [{ label: "Retry", onClick: setup.refresh }],
          }}
        />
      ) : null}
      {plan && !plan.writable ? (
        <Banner
          layout="inline"
          model={{
            id: "android-setup-not-writable",
            tone: "warning",
            title: "ADE cannot write to that folder",
            detail: plan.writableDetail ?? "Pick another install folder.",
            report: false,
            actions: [{ label: "Change folder", onClick: () => void changeInstallFolder() }],
          }}
        />
      ) : null}
      {noSpace && plan ? (
        <Banner
          layout="inline"
          model={{
            id: "android-setup-no-space",
            tone: "warning",
            title: "Not enough free space",
            detail: `The install needs about ${formatAndroidBytes(plan.diskBytesNeeded)}. Free some space or pick a folder on another drive.`,
            report: false,
            actions: [{ label: "Change folder", onClick: () => void changeInstallFolder() }],
          }}
        />
      ) : null}
      {setup.actionError ? (
        <Banner
          layout="inline"
          model={{
            id: "android-setup-action",
            tone: "error",
            title: setup.actionError.sentence,
            error: setup.actionError.detail ?? undefined,
            report: setup.actionError.code === "ANDROID_SDK_PATH_INVALID" ? false : undefined,
            dismiss: { onDismiss: setup.clearActionError },
          }}
        />
      ) : null}
      {install.state === "failed" ? (
        <Banner
          layout="inline"
          model={{
            id: `android-setup-failed-${install.jobId}`,
            tone: "error",
            title: "The install stopped with an error",
            detail: install.error.message,
            report: { surface: "android-sdk-install", code: install.error.code, technicalDetail: install.error.message },
            actions: canInstall ? [{ label: "Try again", onClick: () => setReviewing(true) }] : [],
          }}
        />
      ) : null}
      {install.state === "cancelled" ? (
        <p className="min-w-0 font-sans text-[11px] leading-4 text-muted-fg">
          Install stopped. The finished parts stay, and the next install continues the download.
        </p>
      ) : null}

      {running ? (
        <div className="flex min-w-0 flex-col gap-1.5" data-android-setup-progress="" aria-live="polite">
          {(() => {
            const line = androidInstallLine(install);
            return (
              <>
                <div className="kit-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(line.fraction * 100)} aria-label="Install progress">
                  <span style={{ width: `${Math.max(2, line.fraction * 100)}%` }} />
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="kit-num min-w-0 flex-1 truncate font-sans text-[11px] text-fg/85">{line.text}</span>
                  <SetupButton settings={inSettings} variant="ghost" disabled={install.cancelling} onClick={setup.cancelInstall} data-android-setup-cancel="">
                    {install.cancelling ? "Stopping…" : "Cancel"}
                  </SetupButton>
                </div>
                <span className="kit-num font-sans text-[11px] text-muted-fg">
                  {formatAndroidBytes(install.overallDone)} of {formatAndroidBytes(install.overallTotal)}
                </span>
              </>
            );
          })()}
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {plan?.hostSupported !== false && somethingMissing ? (
            <SetupButton
              settings={inSettings}
              variant="primary"
              disabled={!canInstall || setup.starting}
              onClick={() => setReviewing(true)}
              data-android-setup-install=""
            >
              Review licences & install
            </SetupButton>
          ) : null}
          <SetupButton settings={inSettings} variant="outline" onClick={() => void pickOwnSdk()} data-android-setup-use-mine="">
            {sdk.found && plan && !somethingMissing ? "Use another SDK…" : "Use mine…"}
          </SetupButton>
          <SetupButton
            settings={inSettings}
            variant="ghost"
            disabled={refreshing || setup.loading}
            onClick={() => {
              onRefresh();
              setup.refresh();
            }}
            data-android-setup-refresh=""
          >
            Check again
          </SetupButton>
        </div>
      )}

      {reviewing && plan ? (
        <AndroidLicenseDialog
          licenses={plan.licenses}
          parts={plan.parts}
          downloadBytes={plan.downloadBytes}
          sdkRoot={plan.sdkRoot}
          machineName={machineName}
          starting={setup.starting}
          onCancel={() => setReviewing(false)}
          onAccept={(ids) => {
            // Close either way: a refusal shows on the card, not under the dialog.
            void setup.startInstall(ids).then(() => setReviewing(false));
          }}
        />
      ) : null}
    </div>
  );

  if (variant === "settings") return body;
  return (
    <div className="ade-tool-picker-static flex size-full items-start justify-center overflow-y-auto px-5 py-8">
      {body}
    </div>
  );
}
