import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import {
  QUICK_SLOT_COMMAND_IDS,
  QUICK_SLOT_COUNT,
  quickSlotDigitFromEvent,
  quickSlotAriaShortcut,
  quickSlotLeaderHeld,
  quickSlotLeaderLabel,
  type QuickSlot,
  type QuickSlotArgs,
} from "../../shared/quickSlots";
import { MODAL_LAYER_SELECTOR, keyChordIsClaimed, keyCaptureActive } from "../lib/keyboardClaims";
import { eventMatchesBinding, getEffectiveBinding } from "../lib/keybindings";
import { KEYBINDING_DEFINITIONS } from "../../shared/keybindings";
import { showToast } from "../components/app/toast/toastStore";
import { isMacPlatform } from "../lib/platform";
import { useRootAppStore } from "../state/appStore";
import { ViewportOverlayPortal } from "../components/ui/ViewportOverlayHost";
import {
  QUICK_SLOT_COMMANDS,
  activeProjectStore,
  findQuickSlotCommand,
  profileCommands,
  type QuickSlotCommand,
  type QuickSlotContext,
} from "./commands";
import { getQuickSlotComposer } from "./composerTarget";
import { useQuickSlotsStore } from "./quickSlotsStore";
import "./quickSlots.css";
import { useTabCopyPin } from "../state/repositoryScope";

/** Prompt-box shortcut id → the catalog command it runs. */
const CHAT_SHORTCUTS: ReadonlyArray<{ bindingId: string; commandId: string }> = [
  { bindingId: "chat.effort.up", commandId: QUICK_SLOT_COMMAND_IDS.modelCycleThinking },
  { bindingId: "chat.effort.down", commandId: QUICK_SLOT_COMMAND_IDS.modelThinkingDown },
  { bindingId: "chat.fast.toggle", commandId: QUICK_SLOT_COMMAND_IDS.modelToggleFast },
];

type ResolvedSlot = {
  index: number;
  command: QuickSlotCommand | null;
  args?: QuickSlotArgs;
  label: string;
  detail: string;
  kind: QuickSlotCommand["kind"] | null;
  enabled: boolean;
  reason: string | null;
};

const EMPTY_SLOT: Omit<ResolvedSlot, "index"> = {
  command: null,
  label: "Empty",
  detail: "Assign in Settings",
  kind: null,
  enabled: true,
  reason: null,
};

function resolveSlots(
  slots: readonly QuickSlot[],
  commands: readonly QuickSlotCommand[],
  context: QuickSlotContext,
): ResolvedSlot[] {
  return Array.from({ length: QUICK_SLOT_COUNT }, (_, index) => {
    const slot = slots.find((entry) => entry.index === index + 1);
    if (!slot?.commandId) {
      return { index: index + 1, ...EMPTY_SLOT };
    }
    const command = findQuickSlotCommand(commands, slot.commandId, slot.args);
    if (!command) {
      return {
        index: index + 1,
        command: null,
        label: slot.label?.trim() || "Action unavailable",
        detail: "Pick another action",
        kind: null,
        enabled: false,
        reason: "This action is no longer in the catalogue.",
      };
    }
    const availability = command.enabled?.(context) ?? { ok: true };
    const fallbackDetail = command.hint
      ?? command.title;
    return {
      index: index + 1,
      command,
      args: slot.args,
      // A prompt slot keeps the text preview it was saved with; every other
      // command reads its current title, so a rename is not stale in the HUD.
      label: command.id === QUICK_SLOT_COMMAND_IDS.chatInsertPrompt
        ? (slot.label?.trim() || command.title)
        : command.title,
      detail: command.needs === "lane" && context.lane
        ? `${fallbackDetail} · ${context.lane.name}`
        : fallbackDetail,
      kind: command.kind,
      enabled: availability.ok,
      reason: availability.ok ? null : availability.reason,
    };
  });
}

/**
 * Quick slots: hold the leader chord and tap 1–9.
 *
 * The panel never takes focus. The caret stays in the composer, which is what
 * makes the "caret in the prompt" branch of a model profile possible: the
 * context captures `caretInsideComposer` once, when the panel opens.
 */
export function QuickSlotsHost() {
  const navigate = useNavigate();
  const { slots, profiles, leader, keepOpenAfterRelease } = useQuickSlotsStore(
    useShallow((state) => ({
      slots: state.slots,
      profiles: state.profiles,
      leader: state.leader,
      keepOpenAfterRelease: state.keepOpenAfterRelease,
    })),
  );
  const keybindings = useRootAppStore((state) => state.keybindings);

  const commands = useMemo(
    () => [...QUICK_SLOT_COMMANDS, ...profileCommands(profiles)],
    [profiles],
  );

  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [caretInside, setCaretInside] = useState(false);

  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const keybindingsRef = useRef(keybindings);
  keybindingsRef.current = keybindings;
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const leaderRef = useRef(leader);
  leaderRef.current = leader;
  const keepOpenRef = useRef(keepOpenAfterRelease);
  keepOpenRef.current = keepOpenAfterRelease;
  const openRef = useRef(open);
  openRef.current = open;
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const caretInsideRef = useRef(caretInside);
  caretInsideRef.current = caretInside;

  const holdTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const suppressUntilReleaseRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (holdTimerRef.current != null) window.clearTimeout(holdTimerRef.current);
    if (idleTimerRef.current != null) window.clearTimeout(idleTimerRef.current);
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    holdTimerRef.current = null;
    idleTimerRef.current = null;
    closeTimerRef.current = null;
  }, []);

  const close = useCallback((immediate = false) => {
    clearTimers();
    setArmed(null);
    setHovered(null);
    setMessage(null);
    if (immediate) {
      setOpen(false);
      setClosing(false);
      setAnchor(null);
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      setAnchor(null);
    }, 90);
  }, [clearTimers]);

  // The context's lane is from the tab's own list, so it lives on the tab's copy.
  const tabCopyPin = useTabCopyPin();
  const contextFor = useCallback((caret: boolean): QuickSlotContext => {
    const state = activeProjectStore().getState();
    const composer = getQuickSlotComposer();
    const composerLaneId = composer?.getSnapshot().laneId ?? null;
    // A chat on another machine keeps its lane id, but that lane is not in this
    // tab's list. Follow the chat; never fall back to the sidebar's lane when
    // the chat names one.
    const lane = composerLaneId
      ? (state.lanes.find((entry) => entry.id === composerLaneId) ?? null)
      : (state.lanes.find((entry) => entry.id === state.selectedLaneId) ?? null);
    return {
      navigate: (to) => navigate(to),
      keybindings,
      lane,
      lanePin: lane ? tabCopyPin : null,
      composer,
      caretInsideComposer: caret,
      laneUnavailableReason: composerLaneId && !lane
        ? "This chat's lane is on another machine"
        : null,
    };
  }, [keybindings, navigate, tabCopyPin]);

  const openPanel = useCallback(() => {
    if (openRef.current) return;
    const composer = getQuickSlotComposer();
    const caret = composer?.hasCaret() ?? false;
    setCaretInside(caret);
    setArmed(null);
    setMessage(null);
    setHovered(null);
    const dock = composer?.anchorElement()
      ?? document.querySelector<HTMLElement>("[data-chat-composer-dock]")
      ?? document.querySelector<HTMLElement>("[data-chat-composer-wrapper]");
    const rect = dock?.getBoundingClientRect();
    if (rect && rect.width > 40 && rect.height > 0) {
      setAnchor({
        left: Math.max(12, Math.min(window.innerWidth - 12, rect.left + rect.width / 2)),
        bottom: Math.max(12, window.innerHeight - rect.top + 10),
      });
    } else {
      setAnchor({ left: Math.max(12, window.innerWidth / 2), bottom: 96 });
    }
    setOpen(true);
    setClosing(false);
    if (keepOpenRef.current) {
      idleTimerRef.current = window.setTimeout(() => close(), 4000);
    }
  }, [close]);

  const runSlot = useCallback((index: number, caretOverride?: boolean) => {
    const context = contextFor(caretOverride ?? caretInsideRef.current);
    const resolved = resolveSlots(slotsRef.current, commandsRef.current, context)[index - 1];
    if (!resolved) return;
    // A quick tap never opens the panel, so what it would have said there
    // becomes a toast; otherwise a refused slot looks like a dead key.
    const say = (text: string) => {
      if (openRef.current) setMessage(text);
      else showToast({ id: "quick-slot", title: `Slot ${index}: ${text}`, tone: "info" });
    };
    if (!resolved.command) {
      if (!resolved.reason) {
        // An empty slot is an invitation, not an error.
        navigate("/settings?tab=keyboard#quick-slots");
        close();
      } else {
        say(resolved.reason);
      }
      return;
    }
    if (!resolved.enabled) {
      say(resolved.reason ?? "This action cannot run right now.");
      return;
    }
    const wasArmed = armedRef.current === index;
    if (armedRef.current != null && !wasArmed) setArmed(null);
    if (resolved.command.safety === "confirm" && !wasArmed) {
      setArmed(index);
      say(`Press ${index} again to ${resolved.label.toLowerCase()}`);
      return;
    }
    setArmed(null);
    setMessage(null);
    close();
    void Promise.resolve(resolved.command.run(context, resolved.args)).catch(() => {
      // The command owns its own toast; a thrown promise must not keep the
      // panel in a running state.
    });
    // Product analytics: that Quick slots get used at all, once a day.
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: { feature: "keyboard", action: "quick_slot_used", outcome: "completed", source: "renderer_route" },
      dedupeKey: "keyboard:quick_slot_used",
      minimumIntervalMs: 24 * 60 * 60_000,
    })?.catch(() => undefined);
  }, [close, contextFor, navigate]);

  /**
   * The prompt-box shortcuts (`chat.*` in `shared/keybindings.ts`). They run
   * the same catalog commands a slot would, so the mid-turn and no-tiers
   * rules and their toasts are the same whichever way they were asked for.
   * Without a HUD to explain, a refusal becomes a toast.
   */
  const runChatShortcut = useCallback((event: KeyboardEvent): boolean => {
    const snapshot = keybindingsRef.current;
    const match = CHAT_SHORTCUTS.find((entry) => {
      const fallback = KEYBINDING_DEFINITIONS.find((definition) => definition.id === entry.bindingId)?.defaultBinding ?? "";
      return eventMatchesBinding(event, getEffectiveBinding(snapshot, entry.bindingId, fallback));
    });
    if (!match) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return true;
    // Only a composer on screen is returned, so a Work page left mounted
    // off-route never has its chat changed out of sight.
    const composer = getQuickSlotComposer();
    const context = contextFor(composer?.hasCaret() ?? false);
    const command = commandsRef.current.find((entry) => entry.id === match.commandId);
    if (!command) return true;
    const availability = composer
      ? (command.enabled?.(context) ?? { ok: true as const })
      : { ok: false as const, reason: "Open a chat first" };
    if (!availability.ok) {
      showToast({ id: "chat-shortcut", title: availability.reason ?? "This shortcut cannot run here", tone: "info" });
      return true;
    }
    void Promise.resolve(command.run(context)).catch(() => {});
    return true;
  }, [contextFor]);

  useEffect(() => {
    const isMac = isMacPlatform();
    const isLeaderModifier = (event: KeyboardEvent): boolean => {
      const key = event.key;
      if (isMac) return key === "Alt" || key === "Meta";
      return key === "Control" || key === "Shift";
    };
    const modalOpen = (target: EventTarget | null): boolean => {
      if (keyChordIsClaimed(target)) return true;
      return document.querySelector(MODAL_LAYER_SELECTOR) != null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      // A shortcut recorder owns every key while it listens.
      if (keyCaptureActive()) {
        if (openRef.current) close(true);
        return;
      }
      if (!openRef.current && !modalOpen(event.target) && runChatShortcut(event)) return;
      const digit = quickSlotDigitFromEvent(event);
      const leaderHeld = quickSlotLeaderHeld(event, leaderRef.current, isMac);

      if (openRef.current) {
        if (modalOpen(event.target)) {
          close(true);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          suppressUntilReleaseRef.current = true;
          close();
          return;
        }
        if (digit != null) {
          // Digits work without the modifiers in sticky mode; with them, they
          // are the chord. A bare digit is never swallowed.
          if (leaderHeld || keepOpenRef.current) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) runSlot(digit, getQuickSlotComposer()?.hasCaret() ?? false);
            return;
          }
        }
        if (!isLeaderModifier(event)) {
          close();
        }
        return;
      }

      if (suppressUntilReleaseRef.current) {
        // The leader was let go where this window could not hear it (a web
        // view had focus, or another app did): any press without it starts over.
        if (!leaderHeld) suppressUntilReleaseRef.current = false;
        // Still holding after a slot ran: another digit runs its slot, but the
        // hold does not open the panel.
        else if (digit == null) return;
      }
      if (!leaderHeld) return;
      if (modalOpen(event.target)) return;

      if (digit != null) {
        event.preventDefault();
        event.stopPropagation();
        suppressUntilReleaseRef.current = true;
        if (!event.repeat) runSlot(digit, getQuickSlotComposer()?.hasCaret() ?? false);
        return;
      }
      // Any other key with the leader held is someone else's chord (Ctrl+Shift+N,
      // ⌥⌘I): it must not flash the panel.
      if (!isLeaderModifier(event)) {
        if (holdTimerRef.current != null) {
          window.clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
        }
        return;
      }
      if (holdTimerRef.current == null) {
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null;
          openPanel();
        }, 70);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        suppressUntilReleaseRef.current = false;
        return;
      }
      if (!isLeaderModifier(event)) return;
      // Releasing either half of the leader ends the hold. A keyup reports the
      // modifiers as they were before the release, so the released key itself
      // is what says the chord is no longer complete.
      suppressUntilReleaseRef.current = false;
      if (holdTimerRef.current != null) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (openRef.current && !keepOpenRef.current) close();
    };

    const onBlur = () => {
      suppressUntilReleaseRef.current = false;
      if (openRef.current) close(true);
    };
    const onResize = () => {
      if (openRef.current) close(true);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      // Only the pending hold belongs to these listeners. The close and idle
      // timers outlive a re-subscription (a slot that navigates re-runs this
      // effect mid-close); they are cleared on unmount below.
      if (holdTimerRef.current != null) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
  }, [close, openPanel, runChatShortcut, runSlot]);

  useEffect(() => clearTimers, [clearTimers]);

  // Nine rows of cheap lookups, and none of them run while the panel is
  // closed. Memoizing was not worth a hand-written dependency list: the host
  // re-renders on store changes and open/close, not per keystroke.
  const resolved = open ? resolveSlots(slots, commands, contextFor(caretInside)) : [];
  const hoveredSlot = hovered ? resolved[hovered - 1] ?? null : null;
  const footer = message
    ?? (hoveredSlot
      ? (hoveredSlot.reason ?? `${hoveredSlot.index} · ${hoveredSlot.detail}`)
      : (keepOpenAfterRelease ? "Tap 1–9 · Esc to close" : "Tap 1–9 · release to cancel"));

  if (!open || !anchor) return null;

  return (
    <ViewportOverlayPortal layer="quickSlots">
      <div
        className="ade-qs-away"
        onMouseDown={(event) => {
          event.preventDefault();
          close();
        }}
      />
      <div
        className="ade-qs-anchor"
        style={{ left: anchor.left, bottom: anchor.bottom }}
        onMouseDown={(event) => event.preventDefault()}
      >
        <div
          className="ade-qs-card kit-card"
          data-float="true"
          data-closing={closing ? "true" : undefined}
          role="group"
          aria-label="Quick slots"
        >
          <div className="ade-qs-head">
            <span className="ade-qs-title">Quick slots</span>
            <kbd className="kit-kbd" data-size="sm">{quickSlotLeaderLabel(leader, isMacPlatform())}</kbd>
            <button
              type="button"
              className="ade-qs-edit"
              onClick={() => {
                close();
                navigate("/settings?tab=keyboard#quick-slots");
              }}
            >
              Edit
            </button>
          </div>
          <div className="ade-qs-grid">
            {resolved.map((slot) => {
              const SlotIcon = slot.command?.icon;
              return (
                <button
                  key={slot.index}
                  type="button"
                  className="ade-qs-cell"
                  data-armed={armed === slot.index ? "true" : undefined}
                  data-enabled={slot.enabled && (slot.command || !slot.reason) ? "true" : "false"}
                  data-empty={!slot.command && !slot.reason ? "true" : undefined}
                  aria-keyshortcuts={quickSlotAriaShortcut(slot.index, leader, isMacPlatform())}
                  aria-label={`${slot.index}, ${slot.label}${slot.reason ? `, unavailable: ${slot.reason}` : ""}`}
                  onMouseEnter={() => setHovered(slot.index)}
                  onMouseLeave={() => setHovered((current) => (current === slot.index ? null : current))}
                  onFocus={() => setHovered(slot.index)}
                  onClick={() => runSlot(slot.index)}
                >
                  <span className="ade-qs-num">{slot.index}</span>
                  {SlotIcon
                    ? <SlotIcon size={15} weight="duotone" />
                    : <span className="ade-qs-empty-mark" aria-hidden="true">+</span>}
                  <span className="ade-qs-label">{slot.label}</span>
                  <span className="ade-qs-kind">{slot.kind ? slot.kind.toUpperCase() : "EMPTY"}</span>
                </button>
              );
            })}
          </div>
          <div className="ade-qs-foot" aria-live="polite">
            {footer}
          </div>
        </div>
      </div>
    </ViewportOverlayPortal>
  );
}
