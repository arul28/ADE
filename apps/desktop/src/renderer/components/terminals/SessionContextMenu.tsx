import { useState, useRef, useEffect, type ReactNode } from "react";
import { ContextMenuSurface } from "../ui/ContextMenu";
import {
  Alarm,
  ArrowBendUpRight,
  ArrowCounterClockwise,
  ArrowDown,
  ArrowsLeftRight,
  ArrowUp,
  Bell,
  BellSlash,
  Check,
  CheckCircle,
  ClockCountdown,
  Copy,
  GitBranch,
  GitFork,
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
  ArrowClockwise,
} from "@phosphor-icons/react";
import type {
  AgentChatSessionMetadataField,
  AutomationRuleSummary,
  LaneSummary,
  LaneType,
  OpenProjectBinding,
  TerminalSessionSummary,
  WorkBoardWaitingReason,
} from "../../../shared/types";
import { type WorkBoardMoveTarget } from "../../../shared/types/chat";
import { sessionStatusChangeModel, type SessionStatusOption } from "../../lib/sessionStatusChange";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import { cursorOwnsSessionName, isChatToolType } from "../../lib/sessions";
import { sessionCanonicalUiState, sessionIsMidFlight } from "../../lib/terminalAttention";
import { useSessionMetadataGenerating } from "../../state/sessionMetadataGeneratingStore";
import {
  isSessionSnoozed,
  resolveSnoozePresets,
  snoozeWakeLabel,
  type SnoozeDurationKey,
} from "../../lib/sessionSnooze";
import {
  DESTRUCTIVE_ITEM_CLASS,
  MENU_ITEM_CLASS,
  MenuRowIcon,
  MenuSectionLabel,
  MenuSeparator,
  MenuSubmenu,
} from "../ui/MenuSubmenu";
import { LaneActionsSubmenu } from "./LaneActionsSubmenu";
import { useSessionNotificationMute } from "../activity/useSessionNotificationMute";
import { WorkManageLaneDialogHost } from "./WorkManageLaneDialogHost";
import { OpenInSubmenu } from "../ui/OpenInSubmenu";
import type { OpenInTarget } from "../../../shared/editorTargets";
import {
  automationRulesReadable,
  removeAutomationRules,
  setSessionSettleOverride,
  restartAgentSession,
  setChatSpawnKind,
  snoozeSessionForDuration,
  unsettleSession,
  wakeSessionNow,
} from "./sessionLifecycleActions";
import {
  AutoHandoffModal,
  loadAutoHandoffRulesForSession,
} from "./AutoHandoffModal";
import type { ChatHandoffIntent } from "../../lib/chatHandoffIntent";
import { CrossMachineMoveSubmenu } from "./CrossMachineMoveSubmenu";
import { isImeComposing } from "../../lib/imeComposition";

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
  /** Why the board files this row under Waiting, when the opening surface knows it. */
  waitingReason?: WorkBoardWaitingReason | null;
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
  /**
   * Move a row between the Work-board columns it can actually be in.
   *
   * The same action the board's drag uses (`session.moveOnBoard`): it owns the
   * lifecycle write, the host-authored message the agent reacts to, and the
   * refusal when a live card has to be answered first. Waiting is not a target
   * — it is derived from a snooze, a mid-CI PR, an outstanding review, an armed
   * wake, or a busy subagent.
   */
  onChangeStatus: (
    session: TerminalSessionSummary,
    target: WorkBoardMoveTarget,
    binding?: OpenProjectBinding | null,
  ) => void;
  /**
   * The fold's own reason this row is in Waiting, when the surface knows it.
   * Passed straight into `sessionStatusChangeModel` so the disabled Working
   * entry says "CI running" instead of a generic refusal.
   */
  statusWaitingReason?: WorkBoardWaitingReason | null;
  /**
   * Opens a handoff destination (local or another machine) in the chat pane.
   * The menu cannot open
   * those views itself: they are stateful inside `AgentChatPane`, so it records
   * the intent and the pane acts on it (see `chatHandoffIntent`).
   */
  onOpenChatHandoff: (
    session: TerminalSessionSummary,
    intent: ChatHandoffIntent,
    binding?: OpenProjectBinding | null,
    /** "remote": the machine to preselect in the full setup. */
    options?: { machine?: string | null },
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
  // Hosted here for the same reason the lane dialog is: opening it closes the
  // menu, so a modal mounted inside the panel would unmount in the same tick.
  const [autoHandoff, setAutoHandoff] = useState<{
    session: TerminalSessionSummary;
    binding?: OpenProjectBinding | null;
    existingRules: AutomationRuleSummary[];
  } | null>(null);

  return (
    <>
      {props.menu ? (
        <SessionContextMenuPanel
          {...props}
          menu={props.menu}
          onManageLane={(laneId, extras) => setManagedLane({ laneId, ...extras })}
          onOpenAutoHandoff={(args) => setAutoHandoff(args)}
        />
      ) : null}
      {autoHandoff ? (
        <AutoHandoffModal
          session={autoHandoff.session}
          binding={autoHandoff.binding}
          existingRules={autoHandoff.existingRules}
          onClose={() => setAutoHandoff(null)}
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
  onChangeStatus,
  statusWaitingReason,
  onOpenChatHandoff,
  pinnedSessionIds,
  gridSessionIds,
  onRemoveFromGrid,
  onManageLane,
  onOpenAutoHandoff,
}: Omit<SessionContextMenuProps, "menu"> & {
  menu: NonNullable<SessionContextMenuState>;
  onManageLane: (
    laneId: string,
    extras?: { lane?: LaneSummary; binding?: OpenProjectBinding | null },
  ) => void;
  onOpenAutoHandoff: (args: {
    session: TerminalSessionSummary;
    binding?: OpenProjectBinding | null;
    existingRules: AutomationRuleSummary[];
  }) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [tagging, setTagging] = useState(false);
  // Captured when the submenu opens rather than on every render: a list that
  // re-resolved mid-render could drop the row the pointer is already over if
  // the 17:00 boundary happened to pass while the menu was open.
  const [snoozePresets, setSnoozePresets] = useState(() => resolveSnoozePresets());
  const [draft, setDraft] = useState("");
  /**
   * Auto-handoff rules already scoped to this chat. `null` means "not answered
   * yet": the menu paints immediately and the row settles from "Auto handoff…"
   * to "Edit auto handoff…" when the list comes back, because a context menu
   * that waits on IPC before it appears is a broken context menu.
   */
  const [scopedHandoffRules, setScopedHandoffRules] = useState<AutomationRuleSummary[] | null>(null);
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
  const canRename = !cursorOwnsSessionName(session);
  const isPrimaryLane = laneType === "primary";
  const isRegeneratingMetadata = Boolean(useSessionMetadataGenerating(session.id));
  useEffect(() => {
    // Bail before the await when there is no automations surface at all, so a
    // window without it never schedules a state write it cannot answer.
    if (!isChat || !automationRulesReadable()) {
      setScopedHandoffRules(null);
      return undefined;
    }
    let cancelled = false;
    setScopedHandoffRules(null);
    void loadAutoHandoffRulesForSession(session.id, binding).then((rules) => {
      if (cancelled) return;
      // `null` is a failed/unavailable read and stays null, which keeps the
      // Auto handoff item disabled rather than opening the editor on defaults
      // that would delete rules this read never saw.
      setScopedHandoffRules(rules);
    });
    return () => { cancelled = true; };
  }, [binding, isChat, session.id]);
  const canonicalPhase = sessionCanonicalUiState(session).phase;
  const isActivelyRunning = sessionIsMidFlight(session);
  // Snooze is a visibility overlay, so it is read from the shared snooze
  // derivation and never inferred from the canonical phase.
  const isSnoozed = isSessionSnoozed(session);
  const statusModel = sessionStatusChangeModel({
    session,
    waitingReason: statusWaitingReason ?? null,
  });
  /** Every status entry is the same write as a board drop. */
  const changeStatus = (target: WorkBoardMoveTarget): void => {
    onChangeStatus(session, target, binding);
  };
  const notificationMute = useSessionNotificationMute(session.id);
  const snoozeWake = isSnoozed ? snoozeWakeLabel(session.snoozedUntil) : null;
  const isSettled = canonicalPhase === "settled"
    // A settled row that is mid-turn reads Working (a settle only holds at
    // rest), but the declaration is still there and the person may want to
    // withdraw it before the row goes idle and re-settles.
    || Boolean(session.settledAt)
    || session.settleOverride === "settled";
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
    if (trimmed.length > 0 && canRename) {
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
          if (isImeComposing(e)) return;
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

  /**
   * The status entries, rendered from the shared model so the menu, the board
   * and the tests agree on what a row can become:
   *
   *   Working     only when the session is ALREADY live. A status change cannot
   *               start a model, so an idle row is refused with that reason
   *               instead of being moved somewhere it will not stay.
   *   Needs you   always. The write is a person parking the row for themselves.
   *   Done        always, except over a live provider card (the card, not the
   *               settle, is what has to be answered) and a terminal waiting at
   *               its own prompt with no recorded hand.
   *   Unsettle,   the reverse of Done, shown while the row is declared settled
   *   Keep active (Keep active also pins it so a clean exit cannot re-settle it).
   *   Snoozed     the presets, or Wake now when the row is snoozed — the reverse
   *               state lives where the way in lives.
   *
   * Waiting is deliberately absent: it is derived from a snooze, a mid-CI PR,
   * an outstanding review, an armed wake, or a busy subagent, never asserted.
   */
  const statusDisabledItemClass =
    "flex w-full cursor-not-allowed items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-muted-fg/45";
  const statusMenuContent = (
    <>
      {statusModel.options
        .filter((option): option is SessionStatusOption & { target: WorkBoardMoveTarget } => option.target !== "snoozed")
        .map((option) => {
          const Icon = option.target === "working"
            ? Lightning
            : option.target === "needs_you" ? Bell : CheckCircle;
          const current = option.current;
          const enabled = option.enabled && !current;
          return (
            <button
              key={option.target}
              type="button"
              data-testid={`session-menu-status-${option.target}`}
              className={enabled ? MENU_ITEM_CLASS : statusDisabledItemClass}
              disabled={!enabled}
              title={option.reason
                ?? (current ? `Already ${option.label.toLowerCase()}` : undefined)}
              onClick={() => {
                if (!enabled) return;
                changeStatus(option.target);
                onClose();
              }}
            >
              <MenuRowIcon icon={current ? Check : Icon} />
              {option.label}
              {!option.enabled && option.reason ? (
                <span
                  className="ml-auto max-w-[170px] truncate pl-4 text-[10px] text-muted-fg/50"
                  title={option.reason}
                >
                  {option.reason}
                </span>
              ) : null}
            </button>
          );
        })}

      {isSettled ? (
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
      ) : null}

      <MenuSeparator />
      <MenuSectionLabel>Snooze</MenuSectionLabel>
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
        <>
          {snoozePresets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className={MENU_ITEM_CLASS}
              data-testid={`session-menu-status-snooze-${preset.key}`}
              onClick={() => chooseSnooze(preset.key)}
            >
              <MenuRowIcon icon={ClockCountdown} />
              {preset.label}
              <span className="ml-auto shrink-0 pl-4 text-[10px] text-muted-fg/50">
                {preset.whenLabel}
              </span>
            </button>
          ))}
        </>
      )}
    </>
  );

  // Tag writes need a live Claude SDK runtime (updateSession throws for ended
  // sessions), so the item is only enabled while one runs.
  const canSetTag = session.toolType === "claude-chat" && isRunning;

  const deletingLabel = deletingSessionId === session.id ? "Deleting…" : null;

  const metadataActions = SESSION_METADATA_GENERATION_ACTIONS.filter((action) => {
    const fields = isPrimaryLane && action.primaryFields ? action.primaryFields : action.fields;
    return canRename || !fields.includes("title");
  });
  const showNameStatusSubmenu = !tagging && isChat && Boolean(onRegenerateMetadata) && metadataActions.length > 0;
  const renderNameStatusContent = (): ReactNode => {
    if (renaming) return renameInput;
    const regenerateMetadata = onRegenerateMetadata;
    if (!regenerateMetadata) return null;

    return (
      <>
        {canRename ? (
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
              Rename
            </button>
            <MenuSeparator />
          </>
        ) : null}
        {metadataActions.map((action) => {
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
          label={canRename ? "Name & status" : "Status"}
          icon={<MenuRowIcon icon={TextT} />}
          className={MENU_ITEM_CLASS}
          data-testid="session-menu-name-status"
          title={canRename ? "Rename this chat or refresh its visible metadata with AI" : "Refresh status metadata; rename this agent on cursor.com"}
        >
          {renderNameStatusContent()}
        </MenuSubmenu>
      );
    }
    if (canRename && !renaming && !tagging) {
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
    <ContextMenuSurface
      menuRef={menuRef}
      left={menuPosition.left}
      top={menuPosition.top}
      positioned={Boolean(clampedPosition)}
      onClose={onClose}
      className="min-w-[180px]"
    >
        {/* ── Identity: what this row is called and where it sits. Unlabelled;
            it is the first block under the cursor and needs no signpost. ── */}
        {renaming && !showNameStatusSubmenu ? renameInput : null}
        {tagging && (
          <div className="px-3 py-1.5">
            <input
              ref={inputRef}
              type="text"
              aria-label="Set Claude session tag"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
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
        {/* Every chat row uses the same items in the same ORDER. An item that
            does not apply right now is left out (a column of disabled rows only
            made the menu taller), but nothing ever moves. */}
        {!renaming && !tagging && canSetTag && onSetChatTag ? (
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
            Set tag
          </button>
        ) : null}
        {onTogglePinned ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => { onTogglePinned(session); onClose(); }}
          >
            <MenuRowIcon icon={(pinnedSessionIds ?? []).includes(session.id) ? PushPinSlash : PushPin} />
            {(pinnedSessionIds ?? []).includes(session.id) ? "Unpin" : "Pin"}
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
        {notificationMute.available ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            data-testid="session-menu-mute-notifications"
            title="Applies on every device"
            onClick={() => { notificationMute.toggle(); onClose(); }}
          >
            <MenuRowIcon icon={notificationMute.muted ? Bell : BellSlash} />
            {notificationMute.muted ? "Unmute notifications" : "Mute notifications"}
          </button>
        ) : null}

        {/* ── Lifecycle — every action that changes where the sidebar files this
            row: stop (runtime) and one status submenu (snooze/wake, settle and
            the board columns). Keep it exhaustive: a row that reaches the end of
            this block with nothing rendered is a row the user cannot un-hide. ── */}
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

        <MenuSubmenu
          label="Change status"
          hint={statusModel.currentLabel}
          icon={<MenuRowIcon icon={SquaresFour} />}
          className={MENU_ITEM_CLASS}
          data-testid="session-menu-change-status"
          // Presets resolve against the wall clock at the moment the submenu
          // opens, NOT from the static vocabulary. The static list would offer
          // "This evening" at 11pm, which silently resolves to TOMORROW evening
          // — a menu that quietly does something other than what it says. The
          // hover popover resolve the same way.
          onOpen={() => setSnoozePresets(resolveSnoozePresets())}
        >
          {statusMenuContent}
        </MenuSubmenu>

        {/* Handoff. One submenu, the same three destinations the Chat actions →
            Handoff tab offers: a fresh chat here, one of your other machines, or
            a rule that fires on limit/failure/end. Auto handoff used to be a
            bare row here; folding it in keeps "where should this chat go" in a
            single place instead of split across the menu. */}
        {isChat ? (
          <MenuSubmenu
            label="Hand off"
            icon={<MenuRowIcon icon={ArrowBendUpRight} />}
            className={MENU_ITEM_CLASS}
            data-testid="session-menu-handoff"
          >
            <button
              type="button"
              data-testid="session-menu-handoff-local"
              className={MENU_ITEM_CLASS}
              onClick={() => {
                onOpenChatHandoff(session, "local", binding);
                onClose();
              }}
            >
              <MenuRowIcon icon={GitFork} />
              Local handoff…
            </button>
            <CrossMachineMoveSubmenu
              session={session}
              binding={binding}
              busy={isActivelyRunning}
              onClose={onClose}
              onOpenFullSetup={(machine) => onOpenChatHandoff(session, "remote", binding, { machine })}
            />
            <MenuSeparator />
            <button
              type="button"
              data-testid="session-menu-auto-handoff"
              className={MENU_ITEM_CLASS}
              disabled={scopedHandoffRules === null}
              onClick={() => {
                if (scopedHandoffRules === null) return;
                onOpenAutoHandoff({ session, binding, existingRules: scopedHandoffRules });
                onClose();
              }}
            >
              <MenuRowIcon icon={ArrowsLeftRight} />
              {scopedHandoffRules?.length ? "Edit auto handoff…" : "Auto handoff…"}
            </button>
            {scopedHandoffRules?.length ? (
              <button
                type="button"
                data-testid="session-menu-remove-auto-handoff"
                className={MENU_ITEM_CLASS}
                onClick={() => {
                  void removeAutomationRules(scopedHandoffRules.map((rule) => rule.id), binding);
                  onClose();
                }}
              >
                <MenuRowIcon icon={Prohibit} />
                Remove auto handoff
              </button>
            ) : null}
          </MenuSubmenu>
        ) : null}

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

        {openIn ? (
          <OpenInSubmenu
            rootPath={openIn.rootPath}
            remote={openIn.remote}
            onClose={onClose}
            className={MENU_ITEM_CLASS}
          />
        ) : null}

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

        <MenuSeparator />
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

        {/* ── Disruptive and destructive, last and fenced off. Restarting the
            agent process sits here, not among the everyday lifecycle rows. ── */}
        {canStopRuntime || isChat || (!isRunning && !isChat) ? <MenuSeparator /> : null}
        {isChat ? (
          <button
            type="button"
            data-testid="session-menu-restart-agent"
            className={MENU_ITEM_CLASS}
            title="Fresh provider process, same conversation: picks up new skills, plugins, and MCP servers"
            onClick={() => { void restartAgentSession(session, binding); onClose(); }}
          >
            <MenuRowIcon icon={ArrowClockwise} />
            Restart agent session
          </button>
        ) : null}
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
    </ContextMenuSurface>
  );
}
