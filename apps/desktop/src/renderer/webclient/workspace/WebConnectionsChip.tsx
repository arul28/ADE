import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  CaretDown,
  CircleNotch,
  DesktopTower,
  DotsThree,
} from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT } from "../../components/lanes/laneDesignTokens";
import {
  useOptionalWebWorkspace,
  useWebMachines,
  type WebWorkspaceContextValue,
} from "./WebWorkspaceContext";
import {
  WEB_MACHINE_DOT_COLOR,
  webMachineCatalogKeys,
  webMachineLastSeenPhrase,
  type WebMachineEntry,
} from "./webWorkspaceModel";

// ---------------------------------------------------------------------------
// The hosted client's connections list.
//
// ADE Web has no "This computer", so which machine you are on is the single most
// load-bearing fact in the shell — it gets a permanent chip in the top bar
// instead of a page you navigate to. Everything the retired Hub could do to a
// machine (connect, rename, remove from the account, forget in this browser)
// lives in its popover.
//
// What it is NOT is a switcher. Desktop binds a machine per tab, and the web
// client copies that exactly: the project tab's machine picker is the only
// control that decides which machine a surface talks to. This chip reports
// status and manages the account's machines. Clicking a disconnected row still
// dials it — that is infrastructure, not "make this the app's machine" — and
// the collapsed label mirrors whatever the focused project tab is bound to.
//
// Colors are inline `COLORS`/CSS-variable values rather than Tailwind color
// utilities, matching ConnectionsPanel and every other panel in this app.
// That is not a style preference: this project runs Tailwind v4 with an
// `@theme` block that declares only radii/fonts/shadows, while the palette
// (`--color-card`, `--color-fg`, `--color-border`, …) lives in a plain `:root`
// block Tailwind never sees. So `bg-card`, `text-muted-fg`, `border-border`
// and friends compile to NOTHING — this popover had no background at all (page
// content read straight through it) and `border` fell back to v4's
// `currentColor` default, which is what drew the white boxes. Layout-only
// utilities (flex, gap, rounded, truncate) are real and stay.
// ---------------------------------------------------------------------------

/**
 * Dispatch on `window` to open the connections popover from anywhere. The tab
 * strip's "Connect another machine…" uses it; anything else that wants to put a
 * machine in front of the user should too, rather than growing a second list.
 */
export const WEB_OPEN_CONNECTIONS_EVENT = "ade-web:open-connections";

/**
 * The floating surface, in the same language as CommandPalette's dialog and the
 * desktop Connections panel: one opaque base, a faint accent wash, a real
 * border and a float shadow. `--color-popup-bg` is only declared on the dark
 * theme, so light mode falls back to the raised-surface token instead of
 * inheriting nothing and going transparent again.
 */
const POPOVER_SURFACE: CSSProperties = {
  background:
    "radial-gradient(120% 120% at 0% 0%, color-mix(in srgb, var(--color-accent) 9%, transparent), transparent 55%),"
    + " var(--color-popup-bg, var(--color-surface-raised))",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 14,
  boxShadow: "var(--shadow-float)",
};

/**
 * The one-glance status for a row, kept short enough to actually fit 288px.
 *
 * `reachability` is a full sentence written for a tooltip ("Available —
 * connects when you open a project"); rendered inline it truncated to
 * "AVAILABLE — CONNECTS WHEN YOU OPE…", which is worse than useless. The row
 * shows the status word plus the one detail that changes what you'd do next,
 * and keeps the sentence as the title.
 */
function rowStatusLine(machine: WebMachineEntry): string {
  if (machine.connectStage) return machine.connectStage;
  const projects = machine.projects.length;
  const projectsLabel = projects > 0
    ? `${projects} project${projects === 1 ? "" : "s"}`
    : null;
  if (machine.status === "offline") {
    const seen = webMachineLastSeenPhrase(machine.lastSeenAt);
    return seen ? `Offline · last seen ${seen}` : "Offline";
  }
  return projectsLabel
    ? `${machine.statusLabel} · ${projectsLabel}`
    : machine.statusLabel;
}

export function WebConnectionsChip() {
  const workspace = useOptionalWebWorkspace();
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  /**
   * Where the portaled popover goes, measured from the chip. The header's
   * trailing strip clips its own overflow so it cannot slide under the Windows
   * caption buttons at narrow widths — which also clips anything rendered
   * inline below the header. The desktop Connections panel already escapes
   * through a body portal for exactly this reason; this popover does the same,
   * so it needs explicit coordinates instead of `absolute` in the chip.
   */
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const measureAnchor = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({
      top: rect.bottom + 8,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, []);

  const machines = useWebMachines();

  /**
   * The machine the focused project tab is bound to, when one is focused. The
   * binding is the tab's, not the chip's — the chip only reports it, and a
   * binding change remounts the app shell, so reading it during render is
   * current by construction.
   */
  const boundTargetId = workspace?.adapter.getActiveBinding()?.targetId ?? null;

  /**
   * What the collapsed chip names: the focused tab's machine when there is one,
   * otherwise the machine this browser most recently worked on, and only then
   * whatever the account has.
   */
  const displayed = useMemo(() => {
    const bound = boundTargetId
      ? machines.find((machine) => (
          machine.session?.targetId === boundTargetId
          || machine.environment?.envId === boundTargetId
        ))
      : null;
    const lastKey = workspace?.snapshot.lastActiveMachineKey;
    const recentLive = machines.find(
      (machine) => machine.key === lastKey && machine.status === "live",
    );
    return bound
      ?? recentLive
      ?? machines.find((machine) => machine.status === "live")
      ?? machines.find((machine) => machine.key === lastKey)
      ?? machines[0]
      ?? null;
  }, [boundTargetId, machines, workspace?.snapshot.lastActiveMachineKey]);

  /**
   * The tab strip's "Connect another machine…" opens this popover rather than
   * duplicating the list. A window event keeps that one-way: the tab strip does
   * not need a handle on the chip, and the chip stays the only thing that knows
   * how to render machines.
   */
  useEffect(() => {
    const onOpenRequest = () => setOpen(true);
    window.addEventListener(WEB_OPEN_CONNECTIONS_EVENT, onOpenRequest);
    return () => window.removeEventListener(WEB_OPEN_CONNECTIONS_EVENT, onOpenRequest);
  }, []);

  useEffect(() => {
    if (!open) return;
    measureAnchor();
    window.addEventListener("resize", measureAnchor);
    return () => window.removeEventListener("resize", measureAnchor);
  }, [open, measureAnchor]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      // The popover lives in a body portal, so it is outside rootRef's subtree
      // and needs its own containment check or every click inside it closes it.
      if (rootRef.current?.contains(event.target as Node)) return;
      if (popoverRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setMenuKey(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setMenuKey(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!workspace) return null;

  const run = async (machine: WebMachineEntry, operation: () => Promise<void>) => {
    setBusyKey(machine.key);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyKey(null);
    }
  };

  /**
   * Picking a machine connects it (bug-ledger C2d: a machine the account can
   * reach is never a dead end) and nothing more — no open tab is rebound. The
   * popover closes only once the dial succeeds; a failure has to stay on screen
   * next to the row that caused it.
   */
  const selectMachine = (machine: WebMachineEntry) => {
    setMenuKey(null);
    if (machine.status === "live") {
      setOpen(false);
      return;
    }
    void (async () => {
      let connected = false;
      await run(machine, async () => {
        await workspace.connectMachineEntry(machine);
        connected = true;
      });
      if (connected) setOpen(false);
    })();
  };

  return (
    <div ref={rootRef} className="relative shrink-0" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <style>{POPOVER_STYLES}</style>
      <button
        type="button"
        className="ade-shell-control inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-150"
        style={{ color: COLORS.textSecondary }}
        data-variant="ghost"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Machines, ${displayed ? `${displayed.name} ${displayed.statusLabel.toLowerCase()}` : "none connected"}`}
        title={displayed ? displayed.reachability : "No machines on this account yet"}
        onClick={() => setOpen((value) => !value)}
      >
        <DesktopTower size={12} weight="duotone" className="shrink-0 opacity-85" />
        <span className="max-w-[132px] truncate">{displayed?.name ?? "No machines"}</span>
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            background: WEB_MACHINE_DOT_COLOR[displayed?.status ?? "offline"],
            boxShadow: displayed?.status === "live"
              ? "0 0 8px rgba(52,211,153,0.65)"
              : undefined,
          }}
        />
        <CaretDown size={9} weight="bold" className="shrink-0 opacity-70" />
      </button>

      {open && anchor ? createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Machines"
          data-ade-web-connections
          className="fixed z-[70] w-[300px] overflow-hidden"
          style={{ ...POPOVER_SURFACE, top: anchor.top, right: anchor.right }}
        >
          <div className="max-h-[320px] overflow-auto p-2">
            {machines.length === 0 ? (
              <div
                className="px-3 py-5 text-center text-[11px] leading-5"
                style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}
              >
                No machines on this account yet.
              </div>
            ) : machines.map((machine) => (
              <WebMachineRow
                key={machine.key}
                machine={machine}
                busy={busyKey === machine.key}
                menuOpen={menuKey === machine.key}
                renaming={renameKey === machine.key}
                renameValue={renameValue}
                workspace={workspace}
                run={run}
                selectMachine={selectMachine}
                setMenuKey={setMenuKey}
                setRenameKey={setRenameKey}
                setRenameValue={setRenameValue}
              />
            ))}
          </div>

          {error ? (
            <div
              role="alert"
              className="px-3 py-2 text-[10.5px] leading-4"
              style={{
                borderTop: `1px solid ${COLORS.borderMuted}`,
                background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
                color: COLORS.danger,
                fontFamily: SANS_FONT,
              }}
            >
              {error}
            </div>
          ) : null}
          <div
            className="px-3 py-2.5 text-[10px] leading-4"
            style={{
              borderTop: `1px solid ${COLORS.borderMuted}`,
              background: "color-mix(in srgb, var(--color-fg) 3%, transparent)",
              color: COLORS.textMuted,
              fontFamily: MONO_FONT,
            }}
          >
            To add a machine: sign in to ADE on it.
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

/**
 * One machine in the popover list: status dot, name, connect affordance, the
 * inline rename field, and the ⋯ menu.
 *
 * Every piece of popover state it reads arrives as a boolean already resolved
 * against this row's key, so the row cannot disagree with the list about which
 * row is busy, open, or being renamed.
 */
function WebMachineRow({
  machine,
  busy,
  menuOpen,
  renaming,
  renameValue,
  workspace,
  run,
  selectMachine,
  setMenuKey,
  setRenameKey,
  setRenameValue,
}: {
  machine: WebMachineEntry;
  busy: boolean;
  menuOpen: boolean;
  renaming: boolean;
  renameValue: string;
  workspace: WebWorkspaceContextValue;
  run: (machine: WebMachineEntry, operation: () => Promise<void>) => Promise<void>;
  selectMachine: (machine: WebMachineEntry) => void;
  setMenuKey: (key: string | null) => void;
  setRenameKey: (key: string | null) => void;
  setRenameValue: (value: string) => void;
}) {
  const isLive = machine.status === "live";
  return (
    <div
      data-ade-web-machine-row={machine.key}
      className="ade-web-machine-row px-1.5 py-1.5"
      style={{ borderRadius: 10 }}
    >
      <div className="flex items-center gap-1">
        {/* The row itself is the primary action — selecting a machine
            connects it. The ⋯ menu stays for everything else, so the
            common case costs one click instead of two. */}
        <button
          type="button"
          className="ade-web-machine-select flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-0.5 text-left"
          style={{ opacity: machine.status === "offline" ? 0.62 : 1 }}
          title={machine.reachability}
          aria-label={
            isLive ? `${machine.name}, connected` : `Connect to ${machine.name}`
          }
          onClick={() => selectMachine(machine)}
        >
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{
              background: WEB_MACHINE_DOT_COLOR[machine.status],
              boxShadow: isLive ? "0 0 8px rgba(52,211,153,0.55)" : undefined,
              animation: machine.status === "connecting"
                ? "ade-duty-pulse 1.6s ease-in-out infinite"
                : undefined,
            }}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span
                className="min-w-0 truncate text-[12.5px] font-semibold"
                style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}
              >
                {machine.name}
              </span>
            </span>
            {/* Connected is the one status worth spending colour on:
                it is what the list is consulted for, and muted grey
                made it read the same as "Available". */}
            <span
              className="mt-0.5 block truncate text-[10.5px]"
              style={{
                color: isLive ? COLORS.success : COLORS.textMuted,
                fontFamily: SANS_FONT,
                fontWeight: isLive ? 600 : undefined,
              }}
            >
              {rowStatusLine(machine)}
            </span>
          </span>
        </button>
        {busy ? (
          <CircleNotch
            size={13}
            className="mr-1.5 shrink-0 animate-spin"
            style={{ color: COLORS.accent }}
          />
        ) : (
          <button
            type="button"
            className="ade-shell-control inline-flex h-6 w-6 shrink-0 items-center justify-center"
            data-variant="ghost"
            style={{ color: COLORS.textMuted }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Manage ${machine.name}`}
            onClick={() => setMenuKey(menuOpen ? null : machine.key)}
          >
            <DotsThree size={14} weight="bold" />
          </button>
        )}
      </div>

      {renaming ? (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const machineKey = machine.accountMachine?.machineKey;
            if (!machineKey) return;
            setRenameKey(null);
            void run(machine, () => workspace.renameMachine(machineKey, renameValue.trim() || null));
          }}
        >
          <input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            aria-label={`Name for ${machine.name}`}
            className="ade-web-machine-input h-7 min-w-0 flex-1 rounded-md px-2 text-[11px] outline-none"
            style={{
              border: `1px solid ${COLORS.borderMuted}`,
              background: COLORS.recessedBg,
              color: COLORS.textPrimary,
              fontFamily: SANS_FONT,
            }}
          />
          <button
            type="submit"
            className="ade-shell-control h-7 px-2 text-[10px]"
            data-variant="ghost"
            style={{ color: COLORS.textSecondary }}
          >
            Save
          </button>
        </form>
      ) : null}

      {menuOpen ? (
        <div
          role="menu"
          className="mt-2 flex flex-col gap-0.5 p-1"
          style={{
            borderRadius: 9,
            border: `1px solid ${COLORS.borderMuted}`,
            background: "color-mix(in srgb, var(--color-bg) 55%, transparent)",
          }}
        >
          {machine.status !== "live" ? (
            <MenuRow
              label="Connect"
              onSelect={() => selectMachine(machine)}
            />
          ) : null}
          {machine.accountMachine ? (
            <MenuRow
              label="Rename"
              onSelect={() => {
                setMenuKey(null);
                setRenameValue(machine.name);
                setRenameKey(machine.key);
              }}
            />
          ) : null}
          {machine.accountMachine ? (
            <MenuRow
              label="Remove from account"
              destructive
              onSelect={() => {
                const machineKey = machine.accountMachine?.machineKey;
                if (!machineKey) return;
                setMenuKey(null);
                if (!window.confirm(`Remove ${machine.name} from your ADE account?`)) return;
                void run(machine, async () => {
                  await workspace.removeAccountMachine(machineKey);
                  workspace.forgetMachineCatalog(webMachineCatalogKeys(machine));
                });
              }}
            />
          ) : null}
          {machine.environment ? (
            <MenuRow
              label="Forget on this browser"
              destructive
              onSelect={() => {
                const envId = machine.environment?.envId;
                if (!envId) return;
                setMenuKey(null);
                if (!window.confirm(`Forget ${machine.name} on this browser?`)) return;
                void run(machine, () => workspace.forgetEnvironment(envId));
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuRow({
  label,
  destructive = false,
  onSelect,
}: {
  label: string;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="ade-web-menu-row flex h-7 items-center rounded-md px-2 text-left text-[11px]"
      data-destructive={destructive ? "true" : undefined}
      style={{
        color: destructive ? COLORS.danger : COLORS.textPrimary,
        fontFamily: SANS_FONT,
      }}
    >
      {label}
    </button>
  );
}

/**
 * Hover/focus states only. Everything static is inline above; these need a real
 * stylesheet because they are pseudo-classes, and the Tailwind color utilities
 * that would normally cover them do not exist in this build (see the note at
 * the top of the file).
 */
const POPOVER_STYLES = `
[data-ade-web-connections] .ade-web-machine-row:hover {
  background: color-mix(in srgb, var(--color-fg) 5%, transparent);
}
[data-ade-web-connections] .ade-web-machine-select:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--color-accent) 60%, transparent);
  outline-offset: 1px;
}
[data-ade-web-connections] .ade-web-machine-input:focus {
  border-color: color-mix(in srgb, var(--color-accent) 65%, transparent);
}
[data-ade-web-connections] .ade-web-menu-row:hover {
  background: color-mix(in srgb, var(--color-fg) 7%, transparent);
}
[data-ade-web-connections] .ade-web-menu-row[data-destructive="true"]:hover {
  background: color-mix(in srgb, var(--color-error) 14%, transparent);
}
/* A phone never hovers, so every row here has to be tappable on its own. */
@media (pointer: coarse) {
  [data-ade-web-connections] [role="menuitem"],
  [data-ade-web-connections] button { min-height: 44px; }
}
`;
