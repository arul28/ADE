import { useState } from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CaretRight,
  CheckCircle,
  Cursor,
  Monitor,
  WarningCircle,
} from "@phosphor-icons/react";

import type {
  MacDesktopPermissionKind,
  MacDesktopPermissions,
  MacDesktopSigningState,
} from "../../../shared/types/macDesktop";
import { WORK_TOOL_PRIMARY_BUTTON } from "../terminals/workToolChrome";
import { cn } from "../ui/cn";
import { MAC_DESKTOP_SECONDARY_BUTTON } from "./MacDesktopStateCard";

/**
 * What macOS still has to allow before Mac Desktop works, one row per grant.
 *
 * This replaces a card that named one grant at a time, said "Accessibility"
 * without saying where that is, and had two buttons ("Open … settings" and
 * "Ask macOS") that looked like they did the same thing. Each row now says
 * what the grant is for, whether it is on, and the exact path in System
 * Settings. A missing row has ONE button, which opens that exact list.
 *
 * "Ask macOS" is gone on purpose. It fired the system prompt, which macOS only
 * shows the first time and which itself only offers to open the same list.
 *
 * The help line is for the case the owner actually hit: the switch is on,
 * and macOS still says no, because its row belongs to an older copy of the
 * app. The fix is to remove the row with − and add the app again with +.
 *
 * Two layouts. `page` is the whole pane when there is no display yet and lists
 * both grants. `inline` sits under the pane's top row while a display is live
 * and lists only what is missing.
 */

type PermissionCopy = {
  name: string;
  purpose: string;
  /** The last part of the System Settings path. */
  pathTail: string;
  icon: typeof Monitor;
};

export const MAC_DESKTOP_PERMISSION_COPY: Record<MacDesktopPermissionKind, PermissionCopy> = {
  screenRecording: {
    name: "Screen & System Audio Recording",
    purpose: "Shows this lane's screen in ADE.",
    pathTail: "Screen & System Audio Recording",
    icon: Monitor,
  },
  accessibility: {
    name: "Accessibility",
    purpose: "Lets you and the agent click and type on it.",
    pathTail: "Accessibility",
    icon: Cursor,
  },
};

const PERMISSION_ORDER: MacDesktopPermissionKind[] = ["screenRecording", "accessibility"];

export function macDesktopPermissionPath(kind: MacDesktopPermissionKind): string {
  return `System Settings › Privacy & Security › ${MAC_DESKTOP_PERMISSION_COPY[kind].pathTail}`;
}

/** The grants the host reported as off, Screen Recording first. */
export function macDesktopMissingPermissions(
  permissions: MacDesktopPermissions | null | undefined,
): MacDesktopPermissionKind[] {
  if (!permissions) return [];
  return PERMISSION_ORDER.filter((kind) => permissions[kind] === "denied");
}

/** What the last Check again found, so the card can say it looked. */
export type MacDesktopPermissionCheck =
  | { at: number; stillMissing: MacDesktopPermissionKind[]; error?: undefined }
  | { at: number; error: string; stillMissing?: undefined };

export type MacDesktopPermissionCardProps = {
  variant: "page" | "inline";
  permissions: MacDesktopPermissions;
  /** `status.responsibleAppName`: the name macOS lists. */
  appName: string;
  signing: MacDesktopSigningState;
  /** False when the lane's Mac is another machine: no button can open its settings. */
  hostIsLocal: boolean;
  machineName: string | null;
  checking: boolean;
  lastCheck: MacDesktopPermissionCheck | null;
  onOpenSettings: (kind: MacDesktopPermissionKind) => void;
  onCheckAgain: () => void;
  /** Offered when the picture can work without what is missing. */
  onStartAnyway?: (() => void) | null;
  /** The tool asking. App Control's recorder needs the same grant. */
  productName?: string;
  /** What each grant does for that tool, when it is not Mac Desktop. */
  purposes?: Partial<Record<MacDesktopPermissionKind, string>>;
};

export function MacDesktopPermissionCard({
  variant,
  permissions,
  appName,
  signing,
  hostIsLocal,
  machineName,
  checking,
  lastCheck,
  onOpenSettings,
  onCheckAgain,
  onStartAnyway = null,
  productName = "Mac Desktop",
  purposes,
}: MacDesktopPermissionCardProps) {
  const missing = macDesktopMissingPermissions(permissions);
  const inline = variant === "inline";
  const rows = inline ? missing : PERMISSION_ORDER;
  const where = machineName ?? "the lane's Mac";
  const [helpOpen, setHelpOpen] = useState(signing === "adhoc");

  const title = missing.length > 1
    ? `${productName} needs two permissions`
    : `${productName} needs one more permission`;
  const pronoun = missing.length > 1 ? "these" : "it";
  const subtitle = hostIsLocal
    ? `Turn ${pronoun} on for ${appName} in System Settings.`
    : `Turn ${pronoun} on for ${appName} on ${where}.`;

  const checkResult = lastCheck && !checking ? checkResultText(lastCheck) : null;

  const card = (
    <section
      data-testid={inline ? "mac-desktop-permission-inline" : "mac-desktop-permission-card"}
      aria-label={`${productName} permissions`}
      className={cn(
        "flex w-full min-w-0 flex-col",
        inline
          ? "gap-2 rounded-[10px] border border-[color-mix(in_srgb,var(--color-warning)_28%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-warning)_6%,var(--color-surface))] p-2.5"
          : "ade-tool-card m-auto max-w-[460px] gap-4 p-4",
      )}
    >
      {inline ? null : (
        <header className="flex min-w-0 flex-col gap-1">
          <h2 className="font-sans text-[14px] font-semibold text-fg">{title}</h2>
          <p className="font-sans text-[12px] leading-5 text-muted-fg">{subtitle}</p>
        </header>
      )}

      <ul
        className={cn(
          "flex min-w-0 flex-col overflow-hidden",
          inline ? "gap-2" : "rounded-[10px] border border-border/70 bg-[color-mix(in_srgb,var(--color-bg)_45%,transparent)]",
        )}
      >
        {rows.map((kind, index) => (
          <PermissionRow
            key={kind}
            kind={kind}
            granted={permissions[kind] !== "denied"}
            unknown={permissions[kind] === "unknown"}
            divided={!inline && index > 0}
            compact={inline}
            hostIsLocal={hostIsLocal}
            where={where}
            disabled={checking}
            onOpenSettings={onOpenSettings}
            purpose={purposes?.[kind] ?? null}
          />
        ))}
      </ul>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="mac-desktop-check-again"
          className={inline ? MAC_DESKTOP_SECONDARY_BUTTON : WORK_TOOL_PRIMARY_BUTTON}
          onClick={onCheckAgain}
          disabled={checking}
          aria-busy={checking}
        >
          <ArrowsClockwise size={14} className={checking ? "animate-spin" : undefined} />
          {checking ? "Checking…" : "Check again"}
        </button>
        {onStartAnyway && !inline ? (
          <button
            type="button"
            data-testid="mac-desktop-start-anyway"
            className={MAC_DESKTOP_SECONDARY_BUTTON}
            onClick={onStartAnyway}
            disabled={checking}
          >
            Start without it
          </button>
        ) : null}
        {checkResult ? (
          <span
            data-testid="mac-desktop-check-result"
            role="status"
            className={cn(
              "min-w-0 font-sans text-[12px]",
              checkResult.ok ? "text-[var(--color-success)]" : "text-muted-fg",
            )}
          >
            {checkResult.text}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <button
          type="button"
          data-testid="mac-desktop-permission-help-toggle"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
          className="inline-flex w-fit items-center gap-1 font-sans text-[12px] text-muted-fg transition-colors hover:text-fg"
        >
          <CaretRight
            size={11}
            className={cn("transition-transform duration-[120ms]", helpOpen && "rotate-90")}
          />
          It's on, but still says missing?
        </button>
        {helpOpen ? (
          <ol
            data-testid="mac-desktop-permission-help"
            className="ml-4 flex list-decimal flex-col gap-1 pl-3 font-sans text-[12px] leading-5 text-fg/75"
          >
            <li>{`In the list, select ${appName} and press −.`}</li>
            <li>{`Press +, choose ${appName}, and turn it on.`}</li>
            <li>If macOS asks to quit and reopen, choose Later.</li>
            <li>Press Check again.</li>
            {signing === "adhoc" ? (
              <li className="list-none text-muted-fg" data-testid="mac-desktop-adhoc-note">
                This build is not signed, so macOS forgets the grant each time it updates.
              </li>
            ) : null}
          </ol>
        ) : null}
      </div>
    </section>
  );

  if (inline) return card;
  return (
    <div
      data-testid="mac-desktop-permission-page"
      // `m-auto` on the card, not `items-center` here: a card taller than a
      // short pane must scroll from its top, and centring would clip it.
      className="ade-tool-picker-static flex size-full min-h-0 flex-col overflow-auto rounded-[10px] px-3 py-4"
    >
      {card}
    </div>
  );
}

function checkResultText(check: MacDesktopPermissionCheck): { text: string; ok: boolean } {
  if (check.error) return { text: check.error, ok: false };
  const still = check.stillMissing ?? [];
  if (still.length === 0) return { text: "All set.", ok: true };
  const names = still.map((kind) => MAC_DESKTOP_PERMISSION_COPY[kind].name).join(" and ");
  return { text: `Still off: ${names}.`, ok: false };
}

function PermissionRow({
  kind,
  granted,
  unknown,
  divided,
  compact,
  hostIsLocal,
  where,
  disabled,
  onOpenSettings,
  purpose,
}: {
  kind: MacDesktopPermissionKind;
  granted: boolean;
  unknown: boolean;
  divided: boolean;
  compact: boolean;
  hostIsLocal: boolean;
  where: string;
  disabled: boolean;
  onOpenSettings: (kind: MacDesktopPermissionKind) => void;
  purpose: string | null;
}) {
  const copy = MAC_DESKTOP_PERMISSION_COPY[kind];
  const Icon = copy.icon;
  return (
    <li
      data-testid={`mac-desktop-permission-row-${kind}`}
      data-state={granted ? (unknown ? "unknown" : "granted") : "missing"}
      className={cn(
        "flex min-w-0 items-start gap-3",
        compact ? "" : "p-3",
        divided && "border-t border-border/60",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
          granted
            ? "bg-[color-mix(in_srgb,var(--color-success)_14%,transparent)] text-[var(--color-success)]"
            : "bg-[color-mix(in_srgb,var(--color-warning)_16%,transparent)] text-[var(--color-warning)]",
        )}
      >
        <Icon size={15} weight="duotone" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-sans text-[13px] font-medium text-fg">{copy.name}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1 font-sans text-[11px]",
              granted ? "text-[var(--color-success)]" : "text-[var(--color-warning)]",
            )}
          >
            {granted ? <CheckCircle size={12} weight="fill" /> : <WarningCircle size={12} weight="fill" />}
            {granted ? (unknown ? "Not checked" : "On") : "Off"}
          </span>
        </div>
        <p className="font-sans text-[12px] leading-5 text-muted-fg">{purpose ?? copy.purpose}</p>
        {granted ? null : (
          <p className="font-sans text-[11.5px] leading-5 text-fg/70" data-testid={`mac-desktop-permission-path-${kind}`}>
            {hostIsLocal ? macDesktopPermissionPath(kind) : `On ${where}: ${macDesktopPermissionPath(kind)}`}
          </p>
        )}
        {/* Under the text, not beside it: beside it, a 360px MacBook pane
            squeezed the name and the path into a one-word column. */}
        {!granted && hostIsLocal ? (
          <button
            type="button"
            data-testid={`mac-desktop-open-settings-${kind}`}
            aria-label={`Open ${copy.name} settings`}
            className={cn(MAC_DESKTOP_SECONDARY_BUTTON, "mt-1.5 h-7 w-fit px-2.5")}
            onClick={() => onOpenSettings(kind)}
            disabled={disabled}
          >
            <ArrowSquareOut size={13} />
            Open Settings
          </button>
        ) : null}
      </div>
    </li>
  );
}
