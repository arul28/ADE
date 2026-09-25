import { useEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  ArrowsLeftRight,
  CaretDown,
  Desktop,
  GitPullRequest,
  Stop,
  TerminalWindow,
  Trash,
} from "@phosphor-icons/react";

import type { DevinCloudFleetEntry, DevinCloudFleetStatus } from "../../../shared/types";
import { navigateUrlInAdeBrowser, openExternalUrl } from "../../lib/openExternal";
import {
  DEVIN_BLUE,
  devinCloudModeLabel,
  devinCloudRepoLabel,
  devinCloudStatusToneClass,
  formatDevinCloudAge,
} from "../../lib/devinCloudUtils";
import { cn } from "../ui/cn";

export function devinCloudFleetDisplayStatus(entry: DevinCloudFleetEntry): DevinCloudFleetStatus {
  return entry.fleetStatus;
}

export function isDevinCloudFleetEntryActive(entry: DevinCloudFleetEntry): boolean {
  const status = entry.fleetStatus;
  return status === "starting" || status === "working" || status === "needs_you";
}

function statusPillLabel(status: DevinCloudFleetStatus): string {
  if (status === "needs_you") return "needs you";
  return status;
}

export function StatusPill({ status }: { status: DevinCloudFleetStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[1px]",
        devinCloudStatusToneClass(status),
      )}
    >
      {statusPillLabel(status)}
    </span>
  );
}

function formatAcus(acusConsumed: number | null | undefined): string | null {
  if (acusConsumed == null || Number.isNaN(acusConsumed)) return null;
  return `${Math.round(acusConsumed * 10) / 10} ACU`;
}

export function SectionHeader({
  label,
  count,
  hint,
  accent,
}: {
  label: string;
  count?: number;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 px-1">
      <span
        className={cn(
          "font-sans text-[10px] font-semibold uppercase tracking-[1px]",
          accent ? "text-sky-200/80" : "text-fg/45",
        )}
      >
        {label}
      </span>
      {count != null ? <span className="font-mono text-[10px] text-fg/30">{count}</span> : null}
      {hint ? <span className="text-[10px] text-fg/30">{hint}</span> : null}
    </div>
  );
}

function OwnershipChip({ entry }: { entry: DevinCloudFleetEntry }) {
  const { ownership } = entry;
  if (!ownership.laneName && !ownership.linearIssueId) return null;
  return (
    <span className="inline-flex max-w-[170px] items-center gap-1 truncate rounded-full border border-white/[0.08] bg-white/[0.03] px-1.5 py-px text-[10px] text-fg/55">
      {ownership.linearIssueId ? (
        <span className="font-medium text-fg/65">{ownership.linearIssueId}</span>
      ) : null}
      {ownership.laneName ? (
        <span className="truncate">{ownership.linearIssueId ? `· ${ownership.laneName}` : ownership.laneName}</span>
      ) : null}
    </span>
  );
}

export function FleetRow({
  entry,
  expanded,
  busy,
  confirmingDelete,
  rowError,
  onToggle,
  onOpen,
  onStop,
  onPull,
  onArchive,
  onRequestDelete,
  onConfirmDelete,
  onDismissDelete,
  devinCliAvailable,
  onVmAction,
}: {
  entry: DevinCloudFleetEntry;
  expanded: boolean;
  busy: boolean;
  confirmingDelete: boolean;
  rowError: string | null;
  onToggle: () => void;
  onOpen: () => void;
  onStop: () => void;
  onPull: () => void;
  onArchive: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onDismissDelete: () => void;
  devinCliAvailable: boolean;
  onVmAction: (kind: "ssh" | "steer" | "forward", port?: string) => void;
}) {
  const [liveUrlCopied, setLiveUrlCopied] = useState(false);
  const { session } = entry;
  const status = entry.fleetStatus;
  const active = isDevinCloudFleetEntryActive(entry);
  const age = formatDevinCloudAge(session.updatedAt ?? session.createdAt);
  const acus = formatAcus(session.acusConsumed);
  const finished = status === "finished";
  const repoLabel = session.repos[0] ? devinCloudRepoLabel(session.repos[0]) : null;
  const sessionUrl = session.url?.trim() || null;
  const needsYou = status === "needs_you";

  return (
    <div
      className={cn(
        "group rounded-lg border transition-colors",
        needsYou
          ? "border-amber-300/25 bg-amber-500/[0.04] hover:bg-amber-500/[0.07]"
          : active
            ? "border-sky-300/22 bg-white/[0.02] hover:bg-white/[0.035]"
            : "border-white/[0.06] bg-white/[0.015] hover:border-white/[0.12] hover:bg-white/[0.03]",
      )}
    >
      {/* Div, not button: the row hosts real interactive children (Terminate, Open,
          menu) and nested buttons would drop out of the a11y tree. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left"
      >
        <span className="relative mt-1.5 flex h-2 w-2 shrink-0">
          {active ? (
            <>
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50"
                style={{ background: needsYou ? "#FBBF24" : DEVIN_BLUE }}
              />
              <span
                className="relative inline-flex h-2 w-2 rounded-full"
                style={{ background: needsYou ? "#FBBF24" : DEVIN_BLUE }}
              />
            </>
          ) : (
            <span
              className={cn("inline-flex h-2 w-2 rounded-full", {
                "bg-emerald-400/70": status === "finished",
                "bg-red-400/70": status === "error",
                "bg-white/25": status === "suspended" || status === "archived",
              })}
            />
          )}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate font-sans text-[12.5px] font-semibold tracking-tight text-fg/88">
              {session.title || session.sessionId.slice(0, 12)}
            </span>
            <StatusPill status={status} />
            {age ? <span className="shrink-0 font-mono text-[10px] text-fg/35">{age}</span> : null}
            {acus ? (
              <span className="shrink-0 font-mono text-[10px] font-medium text-emerald-200/70">{acus}</span>
            ) : null}
            {entry.createdViaAde ? (
              <span
                className="inline-flex shrink-0 items-center rounded-full border border-sky-300/20 bg-sky-500/[0.08] px-1.5 py-px font-sans text-[9px] font-medium text-sky-100/70"
                title="This session was launched from ADE"
              >
                via ADE
              </span>
            ) : null}
          </span>
          <span className="flex items-center gap-2 font-mono text-[10.5px] text-fg/42">
            {repoLabel ? <span className="min-w-0 truncate">{repoLabel}</span> : null}
            {session.devinMode ? (
              <span className="shrink-0 text-fg/35">{devinCloudModeLabel(session.devinMode)}</span>
            ) : null}
            <OwnershipChip entry={entry} />
            {entry.prUrl ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  openExternalUrl(entry.prUrl!);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.stopPropagation();
                    openExternalUrl(entry.prUrl!);
                  }
                }}
                className="inline-flex shrink-0 items-center gap-0.5 text-sky-200/70 hover:text-sky-100"
                title="Open pull request"
              >
                <GitPullRequest size={10} weight="bold" /> PR
              </span>
            ) : null}
          </span>
        </span>
        <span
          className="flex shrink-0 items-center gap-1.5 self-center"
          onClick={(event) => event.stopPropagation()}
        >
          {!session.isArchived ? (
            <button
              type="button"
              onClick={onOpen}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-sky-300/25 bg-sky-500/[0.10] px-2 font-sans text-[11px] font-semibold text-sky-100/90 transition-colors hover:border-sky-300/40 hover:bg-sky-500/[0.18] disabled:opacity-40"
              title="Open as an ADE cloud chat — replies keep running in cloud"
            >
              Open
            </button>
          ) : null}
          {sessionUrl ? (
            <button
              type="button"
              onClick={() => navigateUrlInAdeBrowser(sessionUrl, { newTab: true })}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 font-sans text-[10.5px] font-medium text-fg/60 transition-colors hover:border-white/[0.14] hover:text-fg/85 disabled:opacity-40"
              title="Open the live session in ADE's browser — includes Devin's Desktop view"
            >
              <Desktop size={10} weight="bold" /> Live
            </button>
          ) : null}
          {active ? (
            <button
              type="button"
              onClick={onStop}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-red-400/20 bg-red-500/[0.06] px-2 font-sans text-[10.5px] font-medium text-red-200/85 transition-colors hover:bg-red-500/[0.12] disabled:opacity-40"
              title="Terminate this session — works even if it was launched elsewhere"
            >
              <Stop size={10} weight="fill" /> Stop
            </button>
          ) : null}
          <RowMenu
            entry={entry}
            busy={busy}
            confirmingDelete={confirmingDelete}
            finished={finished}
            devinCliAvailable={devinCliAvailable}
            onPull={onPull}
            onArchive={onArchive}
            onVmAction={onVmAction}
            onRequestDelete={onRequestDelete}
            onConfirmDelete={onConfirmDelete}
            onConfirmDismiss={onDismissDelete}
          />
        </span>
      </div>

      {rowError ? (
        <div className="mx-3 mb-2 rounded-md border border-red-400/20 bg-red-500/[0.06] px-2.5 py-1.5 text-[11px] text-red-200/85">
          {rowError}
        </div>
      ) : null}

      {expanded ? (
        <div className="space-y-1.5 border-t border-white/[0.05] px-3.5 py-2.5">
          {session.statusDetail && session.statusDetail !== status ? (
            <div className="line-clamp-3 text-[11.5px] leading-relaxed text-fg/60">{session.statusDetail}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-fg/40">
            <span>session {session.sessionId.slice(0, 14)}…</span>
            {sessionUrl ? (
              <button
                type="button"
                onClick={() => openExternalUrl(sessionUrl)}
                className="inline-flex items-center gap-1 text-fg/50 hover:text-fg/85"
              >
                <ArrowSquareOut size={9} weight="bold" /> app.devin.ai
              </button>
            ) : null}
          </div>
          {sessionUrl ? (
            <div className="flex flex-wrap items-center gap-2 text-[10.5px]">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(sessionUrl).then(() => {
                    setLiveUrlCopied(true);
                    window.setTimeout(() => setLiveUrlCopied(false), 1500);
                  }).catch(() => undefined);
                }}
                className="rounded border border-white/[0.08] px-1.5 py-0.5 text-fg/55 hover:text-fg/85"
              >
                {liveUrlCopied ? "Copied live URL" : "Copy live URL"}
              </button>
              <button
                type="button"
                onClick={() => navigateUrlInAdeBrowser(sessionUrl, { newTab: true })}
                className="inline-flex items-center gap-1 text-sky-200/70 hover:text-sky-100"
              >
                <ArrowSquareOut size={9} weight="bold" /> Open live session in ADE
              </button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-fg/40">
            {session.devinMode ? <span>mode {session.devinMode}</span> : null}
            {acus ? <span>usage {acus}</span> : null}
            <span>matched by {entry.matchedBy}</span>
          </div>
          {session.tags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 font-mono text-[9.5px] text-fg/35">
              {session.tags.slice(0, 8).map((tag) => (
                <span key={tag} className="rounded border border-white/[0.07] bg-white/[0.02] px-1 py-px">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RowMenu({
  entry,
  busy,
  confirmingDelete,
  finished,
  devinCliAvailable,
  onPull,
  onArchive,
  onVmAction,
  onRequestDelete,
  onConfirmDelete,
  onConfirmDismiss,
}: {
  entry: DevinCloudFleetEntry;
  busy: boolean;
  confirmingDelete: boolean;
  finished: boolean;
  devinCliAvailable: boolean;
  onPull: () => void;
  onArchive: () => void;
  onVmAction: (kind: "ssh" | "steer" | "forward", port?: string) => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onConfirmDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const [forwardMode, setForwardMode] = useState(false);
  const [forwardPort, setForwardPort] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setFlipUp(false);
      setForwardMode(false);
      setForwardPort("");
      return;
    }
    const onDocClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
        // Dismissing the menu without acting must also stand down an armed
        // delete confirmation.
        if (confirmingDelete) onConfirmDismiss();
      }
    };
    // Flip the menu above the trigger when it would overflow the viewport
    // bottom; both anchor and menu live in the same offset-parent space.
    const flip = () => {
      const menu = menuRef.current?.querySelector("[data-row-menu-list]") as HTMLElement | null;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      setFlipUp(window.innerHeight - rect.bottom < 8);
    };
    document.addEventListener("mousedown", onDocClick);
    requestAnimationFrame(flip);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, confirmingDelete, onConfirmDismiss]);

  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-fg/70 transition-colors hover:bg-white/[0.06] hover:text-fg/95 disabled:opacity-40";

  const sessionUrl = entry.session.url?.trim() || null;

  return (
    <div ref={menuRef} className="relative" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-md border text-fg/45 transition-colors",
          confirmingDelete
            ? "border-red-400/35 bg-red-500/[0.12] text-red-200/95"
            : "border-white/[0.07] hover:border-white/[0.18] hover:text-fg/85",
          busy && "opacity-40",
        )}
      >
        <CaretDown size={11} weight="bold" />
      </button>
      {open ? (
        <div
          data-row-menu-list
          role="menu"
          className={cn(
            "absolute right-0 z-10 w-[210px] rounded-lg border border-white/[0.10] bg-[#17151f] p-1 shadow-xl shadow-black/50",
            flipUp ? "bottom-8" : "top-8",
          )}
        >
          {sessionUrl ? (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                setOpen(false);
                navigateUrlInAdeBrowser(sessionUrl, { newTab: true });
              }}
            >
              <Desktop size={12} weight="bold" /> Open live session in ADE
            </button>
          ) : null}
          {!entry.session.isArchived ? (
            devinCliAvailable ? (
              <>
                {forwardMode ? (
                  <div className="flex items-center gap-1 px-1 py-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      autoFocus
                      value={forwardPort}
                      onChange={(event) => setForwardPort(event.target.value.replace(/[^0-9:]/g, ""))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && forwardPort.trim()) {
                          setOpen(false);
                          onVmAction("forward", forwardPort.trim());
                        } else if (event.key === "Escape") {
                          setForwardMode(false);
                        }
                      }}
                      placeholder="8080 or 3000:8080"
                      aria-label="VM port to forward"
                      className="h-6 min-w-0 flex-1 rounded border border-white/[0.10] bg-white/[0.04] px-1.5 font-mono text-[10.5px] text-fg/80 outline-none placeholder:text-fg/30"
                    />
                    <button
                      type="button"
                      disabled={!forwardPort.trim()}
                      onClick={() => {
                        setOpen(false);
                        onVmAction("forward", forwardPort.trim());
                      }}
                      className="h-6 shrink-0 rounded border border-sky-300/30 bg-sky-500/[0.12] px-1.5 text-[10px] font-medium text-sky-100/90 disabled:opacity-40"
                    >
                      Forward
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className={itemClass}
                      disabled={busy}
                      title="devin ssh — shell on the session's VM"
                      onClick={() => { setOpen(false); onVmAction("ssh"); }}
                    >
                      <TerminalWindow size={12} weight="bold" /> SSH into VM
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={itemClass}
                      disabled={busy}
                      title="devin forward — map a VM port to localhost"
                      onClick={() => setForwardMode(true)}
                    >
                      <ArrowsLeftRight size={12} weight="bold" /> Forward port…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={itemClass}
                      disabled={busy}
                      title="devin --cloud -r — steer this session from a terminal"
                      onClick={() => { setOpen(false); onVmAction("steer"); }}
                    >
                      <TerminalWindow size={12} weight="bold" /> Steer in terminal
                    </button>
                  </>
                )}
              </>
            ) : (
              <div
                className="px-2 py-1.5 text-[10.5px] leading-snug text-fg/35"
                title="Install the devin CLI to SSH into session VMs, forward ports, or steer in a terminal"
              >
                Install the <span className="font-mono">devin</span> CLI for SSH / port-forward / steer actions.
              </div>
            )
          ) : null}
          {finished && !entry.session.isArchived && entry.prUrl ? (
            <button type="button" role="menuitem" className={itemClass} onClick={() => { setOpen(false); onPull(); }}>
              <GitPullRequest size={12} weight="bold" className="rotate-90" />
              Pull into lane…
            </button>
          ) : null}
          <button type="button" role="menuitem" className={itemClass} onClick={() => { setOpen(false); onArchive(); }} disabled={busy}>
            {entry.session.isArchived ? "Unarchive session" : "Archive session"}
          </button>
          {entry.prUrl ? (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => { setOpen(false); openExternalUrl(entry.prUrl!); }}
            >
              <GitPullRequest size={12} weight="bold" /> Open PR
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={cn(itemClass, confirmingDelete ? "text-red-200/95" : "text-red-300/80 hover:text-red-200")}
            onClick={() => {
              if (confirmingDelete) {
                setOpen(false);
                onConfirmDelete();
              } else {
                onRequestDelete();
              }
            }}
            disabled={busy}
          >
            <Trash size={12} weight="bold" />
            {confirmingDelete ? "Click again to delete forever" : "Delete session…"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
