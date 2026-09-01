import { useState, useRef, useEffect, type ReactNode } from "react";
import {
  Alarm,
  ArrowCounterClockwise,
  ArrowDown,
  ArrowUp,
  CheckCircle,
  ClockCountdown,
  Copy,
  GitBranch,
  Globe,
  Hash,
  Lightning,
  Link,
  PencilSimple,
  Prohibit,
  PushPin,
  PushPinSlash,
  Sparkle,
  SquaresFour,
  Stop,
  Tag,
  TextT,
  Trash,
  type Icon,
} from "@phosphor-icons/react";
import type {
  AgentChatSessionMetadataField,
  LaneSummary,
  LaneType,
  OpenProjectBinding,
  TerminalSessionSummary,
} from "../../../shared/types";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import { isChatToolType } from "../../lib/sessions";
import { sessionCanonicalUiState, sessionIsMidFlight } from "../../lib/terminalAttention";
import { useSessionMetadataGenerating } from "../../state/sessionMetadataGeneratingStore";
import {
  isSessionSnoozed,
  resolveSnoozePresets,
  snoozeWakeLabel,
  type SnoozeDurationKey,
} from "../../lib/sessionSnooze";
import { MenuSectionLabel, MenuSeparator, MenuSubmenu } from "../ui/MenuSubmenu";
import { LaneActionsSubmenu } from "./LaneActionsSubmenu";
import { WorkManageLaneDialogHost } from "./WorkManageLaneDialogHost";
import { OpenInSubmenu } from "../ui/OpenInSubmenu";
import type { OpenInTarget } from "../../../shared/editorTargets";
import {
  setSessionSettleOverride,
  setChatSpawnKind,
  snoozeSessionForDuration,
  unsettleSession,
  wakeSessionNow,
} from "./sessionLifecycleActions";

/* `hover:bg-muted/40` used to be the hover here and read as nothing at all:
   `--color-muted` is #1E1B28, a near-black purple, so 40% of it over an already
   dark menu is imperceptible. Menu rows now use the same white-alpha fill every
   other hoverable surface in the sidebar uses, so "this row is under my cursor"
   is actually visible. */
const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] outline-none";
const DESTRUCTIVE_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-red-300 transition-colors hover:bg-red-500/10";

function MenuRowIcon({ icon: Icon, danger = false }: { icon: Icon; danger?: boolean }) {
  return (
    <span
      aria-hidden
      data-menu-icon=""
      className={danger ? "inline-flex shrink-0 text-red-300/70" : "inline-flex shrink-0 text-fg/45"}
    >
      <Icon size={13} weight="duotone" />
    </span>
  );
}

const SESSION_METADATA_GENERATION_ACTIONS: ReadonlyArray<{
  label: string;
  fields: AgentChatSessionMetadataField[];
  emphasis?: boolean;
  laneNameOnly?: boolean;
  primaryLabel?: string;
  primaryFields?: AgentChatSessionMetadataField[];
}> = [
  { label: "Generate chat title", fields: ["title"] },
  { label: "Generate lane name", fields: ["laneName"], laneNameOnly: true },
  { label: "Generate status line", fields: ["statusLine"] },
  {
    label: "Generate all three",
    fields: ["title", "laneName", "statusLine"],
    emphasis: true,
    primaryLabel: "Generate title & status",
    primaryFields: ["title", "statusLine"],
  },
];

/**
 * Carried only by a row whose lane renders WITHOUT a divider (the singleton
 * form). That row is the lane's only visible surface, so right-clicking it is
 * the only gesture left that could reach lane management — without this the
 * whole lane menu (rename, pin, colour, manage, delete) is unreachable for a
 * one-chat lane.
 *
 * The lane's actions render as a hover submenu built from the SAME item
 * definitions and the SAME action wiring the lane divider's own menu uses
 * (`buildLaneMenuGroups` + `useLaneMenuActions`), so the two surfaces cannot
 * drift. A foreign singleton passes its lane + binding in; `open` survives as
 * the escape hatch only when that lane still cannot be resolved.
 */
export type SessionContextMenuLaneActions = {
  laneId: string;
  laneName: string;
  /** Opens the real lane context menu, anchored where the session menu opened. */
  open: (position: { x: number; y: number }) => void;
  /**
   * The lane this row stands for. Required for a foreign singleton: that lane
   * is not in the local store, and without it the submenu used to collapse to
   * "Open lane menu…".
   */
  lane?: LaneSummary | null;
  binding?: OpenProjectBinding | null;
  machineId?: string | null;
  onToggleWorkPin?: (laneId: string) => void;
  workPinnedLaneIds?: string[];
  workPinLaneId?: string;
};

export type SessionContextMenuOpenIn = OpenInTarget;

export type SessionContextMenuState = {
  session: TerminalSessionSummary;
  binding?: OpenProjectBinding | null;
  machineName?: string | null;
  openIn?: SessionContextMenuOpenIn | null;
  laneType?: LaneType | null;
  /** Present only for a singleton lane's card (see the type above). */
  laneActions?: SessionContextMenuLaneActions | null;
  x: number;
  y: number;
} | null;

type SessionContextMenuProps = {
  menu: SessionContextMenuState;
  onClose: () => void;
  onStopRuntime: (
    args: { ptyId: string; sessionId: string },
    binding?: OpenProjectBinding | null,
  ) => void;
  onStopAndDelete: (
    session: TerminalSessionSummary,
    binding?: OpenProjectBinding | null,
  ) => void;
  onDeleteChat: (
    session: TerminalSessionSummary,
    binding?: OpenProjectBinding | null,
  ) => void;
  onDeleteSession: (
    session: TerminalSessionSummary,
    binding?: OpenProjectBinding | null,
  ) => void;
  deletingSessionId: string | null;
  onGoToLane: (
    session: TerminalSessionSummary,
    binding?: OpenProjectBinding | null,
  ) => void;
  onCopySessionId: (id: string) => void;
  onRename: (
    session: TerminalSessionSummary,
    newTitle: string,
    binding?: OpenProjectBinding | null,
  ) => void;
  onRegenerateMetadata?: (
    session: TerminalSessionSummary,
    fields: AgentChatSessionMetadataField[],
    binding?: OpenProjectBinding | null,
  ) => void;
  onSetChatTag?: (
    session: TerminalSessionSummary,
    tag: string | null,
    binding?: OpenProjectBinding | null,
  ) => void;
  onCopySessionDeepLink?: (session: TerminalSessionSummary) => void;
  onOpenSessionInWeb?: (session: TerminalSessionSummary) => void;
  onTogglePinned?: (session: TerminalSessionSummary) => void;
  onSettle?: (
    session: TerminalSessionSummary,
    binding?: OpenProjectBinding | null,
  ) => void;
  pinnedSessionIds?: string[];
  /** Session ids currently in any work grid (drives the "Remove from grid" item). */
  gridSessionIds?: string[];
  onRemoveFromGrid?: (session: TerminalSessionSummary) => void;
};

/**
 * Shell. Owns nothing but the lane manage dialog, which has to outlive the menu
 * that opened it — "Manage Lane" closes the menu, so a dialog hosted inside the
 * panel would unmount in the same tick it was asked for.
 */
export function SessionContextMenu(props: SessionContextMenuProps) {
  const [managedLane, setManagedLane] = useState<{
    laneId: string;
    lane?: LaneSummary;
    binding?: OpenProjectBinding | null;
  } | null>(null);

  return (
    <>
      {props.menu ? (
        <SessionContextMenuPanel
          {...props}
          menu={props.menu}
          onManageLane={(laneId, extras) => setManagedLane({ laneId, ...extras })}
        />
      ) : null}
      {managedLane ? (
        <WorkManageLaneDialogHost
          laneId={managedLane.laneId}
          lane={managedLane.lane}
          runtimePin={managedLane.binding ?? undefined}
          onClose={() => setManagedLane(null)}
        />
      ) : null}
    </>
  );
}

function SessionContextMenuPanel({
  menu,
  onClose,
  onStopRuntime,
  onStopAndDelete,
  onDeleteChat,
  onDeleteSession,
  deletingSessionId,
  onGoToLane,
  onCopySessionId,
  onRename,
  onRegenerateMetadata,
  onSetChatTag,
  onCopySessionDeepLink,
  onOpenSessionInWeb,
  onTogglePinned,
  onSettle,
  pinnedSessionIds,
  gridSessionIds,
  onRemoveFromGrid,
  onManageLane,
}: Omit<SessionContextMenuProps, "menu"> & {
  menu: NonNullable<SessionContextMenuState>;
  onManageLane: (
    laneId: string,
    extras?: { lane?: LaneSummary; binding?: OpenProjectBinding | null },
  ) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [tagging, setTagging] = useState(false);
  // Captured when the submenu opens rather than on every render: a list that
  // re-resolved mid-render could drop the row the pointer is already over if
  // the 17:00 boundary happened to pass while the menu was open.
  const [snoozePresets, setSnoozePresets] = useState(() => resolveSnoozePresets());
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const finalizedRef = useRef(false);
  const { ref: menuRef, position: clampedPosition } = useClampedFixedPosition(
    { x: menu.x, y: menu.y },
    renaming || tagging,
  );

  // Reset inline edit state when the target menu changes.
  useEffect(() => {
    setRenaming(false);
    setTagging(false);
    setDraft("");
    finalizedRef.current = false;
  }, [menu]);

  // Focus whichever inline editor was opened.
  useEffect(() => {
    if ((renaming || tagging) && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming, tagging]);

  const {
    session,
    binding = null,
    laneActions = null,
    openIn = null,
    laneType = null,
    x,
    y,
  } = menu;
  const menuPosition = clampedPosition ?? { left: x, top: y };
  const isRunning = session.status === "running";
  const isChat = isChatToolType(session.toolType);
  const isPrimaryLane = laneType === "primary";
  const isRegeneratingMetadata = Boolean(useSessionMetadataGenerating(session.id));
  const canonicalPhase = sessionCanonicalUiState(session).phase;
  const isActivelyRunning = sessionIsMidFlight(session);
  const canDismissNeedsYou =
    canonicalPhase !== "needs_you"
    || isChat
    || Boolean(session.attentionRequestedAt);
  // Snooze is a visibility overlay, so it is read from the shared snooze
  // derivation and never inferred from the canonical phase.
  const isSnoozed = isSessionSnoozed(session);
  const snoozeWake = isSnoozed ? snoozeWakeLabel(session.snoozedUntil) : null;
  const isSettled = canonicalPhase === "settled";
  const isDeclaredSettled = Boolean(session.settledAt);
  const canStopRuntime = isRunning && Boolean(session.ptyId) && !isChat;
  const chooseSnooze = (key: SnoozeDurationKey) => {
    void snoozeSessionForDuration(session, key, Date.now(), binding);
    onClose();
  };

  const commitRename = () => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    const trimmed = draft.trim();
    if (trimmed.length > 0) {
      onRename(session, trimmed, binding);
    }
    onClose();
  };
  const commitTag = () => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    const trimmed = draft.trim();
    onSetChatTag?.(session, trimmed.length ? trimmed : null, binding);
    onClose();
  };

  const renameInput = (
    <div className="px-3 py-1.5">
      <input
        ref={inputRef}
        type="text"
        aria-label="Rename session"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commitRename(); }
          if (e.key === "Escape") { e.preventDefault(); finalizedRef.current = true; onClose(); }
        }}
        onBlur={commitRename}
        className="w-full rounded border border-border/30 bg-transparent px-2 py-1 text-xs text-[--color-fg] outline-none focus:border-[--color-accent]"
        placeholder="Enter title..."
        maxLength={48}
      />
    </div>
  );

  // Hoisted out of the JSX only because the settle branch is a four-way chain;
  // inline it would bury the grouping it sits inside.
  const settleRow = isSettled ? (
    <>
      <button
        type="button"
        className={MENU_ITEM_CLASS}
        onClick={() => {
          // Declared settles clear the column; derived settles have no
          // column to clear, so the keep-active pin is the only unsettle.
          // Both branches live in the shared lifecycle action.
          void unsettleSession(session, binding);
          onClose();
        }}
      >
        <MenuRowIcon icon={ArrowCounterClockwise} />
        Unsettle
      </button>
      {isDeclaredSettled ? (
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          title="Pin this session active so a clean exit cannot re-settle it"
          onClick={() => { void setSessionSettleOverride(session, "active", binding); onClose(); }}
        >
          <MenuRowIcon icon={Lightning} />
          Keep active
        </button>
      ) : null}
    </>
  ) : !isActivelyRunning && onSettle && canDismissNeedsYou ? (
    <button
      type="button"
      className={MENU_ITEM_CLASS}
      onClick={() => { onSettle(session, binding); onClose(); }}
    >
      <MenuRowIcon icon={CheckCircle} />
      {canonicalPhase === "needs_you" ? "Dismiss & settle" : "Settle"}
    </button>
  ) : canonicalPhase === "needs_you" && !canDismissNeedsYou ? (
    <button
      type="button"
      className="flex w-full cursor-not-allowed items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-muted-fg/45"
      disabled
      title="Resolve the terminal prompt before settling this session"
    >
      <MenuRowIcon icon={Prohibit} />
      Resolve input to settle
    </button>
  ) : null;

  const deletingLabel = deletingSessionId === session.id ? "Deleting…" : null;

  const showNameStatusSubmenu = !tagging && isChat && Boolean(onRegenerateMetadata);
  const renderNameStatusContent = (): ReactNode => {
    if (renaming) return renameInput;
    const regenerateMetadata = onRegenerateMetadata;
    if (!regenerateMetadata) return null;

    return (
      <>
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={() => {
            finalizedRef.current = false;
            setDraft(session.title);
            setRenaming(true);
          }}
        >
          <MenuRowIcon icon={PencilSimple} />
          Rename…
        </button>
        <MenuSeparator />
        {SESSION_METADATA_GENERATION_ACTIONS.map((action) => {
          const label = isPrimaryLane && action.primaryLabel ? action.primaryLabel : action.label;
          const fields = isPrimaryLane && action.primaryFields ? action.primaryFields : action.fields;
          const disabled = isRegeneratingMetadata || (action.laneNameOnly === true && isPrimaryLane);
          return (
            <button
              key={action.label}
              type="button"
              className={`${MENU_ITEM_CLASS}${action.laneNameOnly ? " disabled:cursor-not-allowed disabled:text-muted-fg/45" : ""}${action.emphasis ? " font-medium" : ""}`}
              disabled={disabled}
              title={action.laneNameOnly && isPrimaryLane ? "The primary lane keeps its name" : undefined}
              onClick={() => { regenerateMetadata(session, fields, binding); onClose(); }}
            >
              <MenuRowIcon icon={Sparkle} />
              {isRegeneratingMetadata ? "Generating…" : label}
            </button>
          );
        })}
      </>
    );
  };

  const renderIdentityContent = (): ReactNode => {
    if (showNameStatusSubmenu) {
      return (
        <MenuSubmenu
          label="Name & status"
          icon={<MenuRowIcon icon={TextT} />}
          className={MENU_ITEM_CLASS}
          data-testid="session-menu-name-status"
          title="Rename this chat or refresh its visible metadata with AI"
        >
          {renderNameStatusContent()}
        </MenuSubmenu>
      );
    }
    if (!renaming && !tagging) {
      return (
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={() => { setDraft(session.title); setRenaming(true); }}
        >
          <MenuRowIcon icon={PencilSimple} />
          Rename
        </button>
      );
    }
    return null;
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />

      {/* Menu */}
      <div
        ref={menuRef}
        className="ade-liquid-glass-menu fixed z-50 min-w-[180px] py-1"
        style={{
          ...menuPosition,
          visibility: clampedPosition ? "visible" : "hidden",
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* ── Identity: what this row is called and where it sits. Unlabelled;
            it is the first block under the cursor and needs no signpost. ── */}
        {renaming && !(isChat && onRegenerateMetadata) ? renameInput : null}
        {tagging && (
          <div className="px-3 py-1.5">
            <input
              ref={inputRef}
              type="text"
              aria-label="Set Claude session tag"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitTag(); }
                if (e.key === "Escape") { e.preventDefault(); finalizedRef.current = true; onClose(); }
              }}
              onBlur={commitTag}
              className="w-full rounded border border-border/30 bg-transparent px-2 py-1 text-xs text-[--color-fg] outline-none focus:border-[--color-accent]"
              placeholder="Tag (empty clears)..."
              maxLength={48}
            />
          </div>
        )}
        {renderIdentityContent()}
        {/* Tag writes need a live Claude SDK runtime (updateSession throws for
            ended sessions), so only offer the item while the session runs. */}
        {!renaming && !tagging && session.toolType === "claude-chat" && isRunning && onSetChatTag ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => {
              finalizedRef.current = false;
              setDraft(session.claudeTag ?? "");
              setTagging(true);
            }}
          >
            <MenuRowIcon icon={Tag} />
            Set tag…
          </button>
        ) : null}
        {onTogglePinned ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => { onTogglePinned(session); onClose(); }}
          >
            <MenuRowIcon icon={(pinnedSessionIds ?? []).includes(session.id) ? PushPinSlash : PushPin} />
            {(pinnedSessionIds ?? []).includes(session.id) ? "Unpin from front" : "Pin to front"}
          </button>
        ) : null}
        {onRemoveFromGrid && (gridSessionIds ?? []).includes(session.id) ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => { onRemoveFromGrid(session); onClose(); }}
          >
            <MenuRowIcon icon={SquaresFour} />
            Remove from grid
          </button>
        ) : null}

        {/* ── Lifecycle — every action that changes where the sidebar files this
            row: stop (runtime), snooze/wake (visibility) and settle/keep-active
            (state). Keep it exhaustive: a row that reaches the end of this block
            with nothing rendered is a row the user cannot un-hide. ── */}
        <MenuSeparator />
        <MenuSectionLabel>Lifecycle</MenuSectionLabel>
        {canStopRuntime ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => {
              onStopRuntime({ ptyId: session.ptyId!, sessionId: session.id }, binding);
              onClose();
            }}
          >
            <MenuRowIcon icon={Stop} />
            Stop runtime
          </button>
        ) : null}

        {isSnoozed ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => { void wakeSessionNow(session, binding); onClose(); }}
          >
            <MenuRowIcon icon={Alarm} />
            Wake now
            {snoozeWake ? (
              <span className="ml-auto shrink-0 text-[10px] text-muted-fg/50">{snoozeWake}</span>
            ) : null}
          </button>
        ) : (
          <MenuSubmenu
            label="Snooze…"
            icon={<MenuRowIcon icon={ClockCountdown} />}
            className={MENU_ITEM_CLASS}
            // Resolved against the wall clock at the moment the submenu opens,
            // NOT from the static vocabulary. The static list would offer "This
            // evening" at 11pm, which silently resolves to TOMORROW evening — a
            // menu that quietly does something other than what it says. The
            // hover popover and the `ade code` TUI resolve the same way.
            onOpen={() => setSnoozePresets(resolveSnoozePresets())}
          >
            {snoozePresets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={MENU_ITEM_CLASS}
                onClick={() => chooseSnooze(preset.key)}
              >
                <MenuRowIcon icon={ClockCountdown} />
                {preset.label}
                <span className="ml-auto shrink-0 pl-4 text-[10px] text-muted-fg/50">
                  {preset.whenLabel}
                </span>
              </button>
            ))}
          </MenuSubmenu>
        )}

        {settleRow}

        {isChat && session.orchestrationParentSessionId && session.spawnKind === "subagent" ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => { void setChatSpawnKind(session, "peer", binding); onClose(); }}
          >
            <MenuRowIcon icon={ArrowDown} />
            Demote to peer
          </button>
        ) : null}
        {isChat && session.orchestrationParentSessionId && session.spawnKind === "peer" ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => { void setChatSpawnKind(session, "subagent", binding); onClose(); }}
          >
            <MenuRowIcon icon={ArrowUp} />
            Promote to subagent
          </button>
        ) : null}

        {/* ── Go to: the surfaces outside this menu that show the same session. ── */}
        <MenuSeparator />
        <MenuSectionLabel>Go to</MenuSectionLabel>
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={() => { onGoToLane(session, binding); onClose(); }}
        >
          <MenuRowIcon icon={GitBranch} />
          Go to lane
        </button>
        {onOpenSessionInWeb ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => { onOpenSessionInWeb(session); onClose(); }}
          >
            <MenuRowIcon icon={Globe} />
            Open in web
          </button>
        ) : null}

        {/* ── Copy: near-identical clipboard rows, collapsed behind one. ── */}
        <MenuSubmenu label="Copy" icon={<MenuRowIcon icon={Copy} />} className={MENU_ITEM_CLASS}>
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => { onCopySessionId(session.id); onClose(); }}
          >
            <MenuRowIcon icon={Hash} />
            Session ID
          </button>
          {onCopySessionDeepLink ? (
            <button
              type="button"
              className={MENU_ITEM_CLASS}
              onClick={() => { onCopySessionDeepLink(session); onClose(); }}
            >
              <MenuRowIcon icon={Link} />
              Session deep link
            </button>
          ) : null}
        </MenuSubmenu>

        {openIn ? (
          <OpenInSubmenu
            rootPath={openIn.rootPath}
            remote={openIn.remote}
            onClose={onClose}
            className={MENU_ITEM_CLASS}
          />
        ) : null}

        {/* Lane section — only on a singleton row, which has no lane divider to
            right-click. Appended to THIS menu rather than bound to a second
            gesture on some sub-region of the card: a hidden gesture nobody can
            discover is the same as no gesture at all. */}
        {laneActions ? (
          <LaneActionsSubmenu
            laneId={laneActions.laneId}
            laneName={laneActions.laneName}
            lane={laneActions.lane}
            binding={laneActions.binding}
            machineId={laneActions.machineId}
            onToggleWorkPin={laneActions.onToggleWorkPin}
            workPinnedLaneIds={laneActions.workPinnedLaneIds}
            workPinLaneId={laneActions.workPinLaneId}
            onClose={onClose}
            onManageLane={onManageLane}
            onFallbackOpen={laneActions.open}
            anchor={{ x, y }}
            triggerClassName={MENU_ITEM_CLASS}
          />
        ) : null}

        {/* ── Destructive, last and fenced off. ── */}
        {canStopRuntime || isChat || (!isRunning && !isChat) ? <MenuSeparator /> : null}
        {canStopRuntime ? (
          <button
            type="button"
            className={DESTRUCTIVE_ITEM_CLASS}
            disabled={deletingSessionId === session.id}
            onClick={() => { onStopAndDelete(session, binding); onClose(); }}
          >
            <MenuRowIcon icon={Trash} danger />
            {deletingLabel ?? "Stop & delete"}
          </button>
        ) : null}
        {isChat ? (
          <button
            type="button"
            className={DESTRUCTIVE_ITEM_CLASS}
            disabled={deletingSessionId === session.id}
            onClick={() => { onDeleteChat(session, binding); onClose(); }}
          >
            <MenuRowIcon icon={Trash} danger />
            {deletingLabel ?? "Delete chat"}
          </button>
        ) : null}
        {!isRunning && !isChat ? (
          <button
            type="button"
            className={DESTRUCTIVE_ITEM_CLASS}
            disabled={deletingSessionId === session.id}
            onClick={() => { onDeleteSession(session, binding); onClose(); }}
          >
            <MenuRowIcon icon={Trash} danger />
            {deletingLabel ?? "Delete session"}
          </button>
        ) : null}
      </div>
    </>
  );
}
