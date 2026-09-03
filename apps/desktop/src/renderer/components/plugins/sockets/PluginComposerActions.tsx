import React from "react";

import type { PluginComposerContext } from "../../../../shared/plugins/context";
import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import { contributionKey } from "./contributionModel";
import { usePluginSocketInvoke, useSurfaceContributions } from "./useSurfaceContributions";
import { brandIconsProp, usePluginBrandIcons } from "./usePluginBrandIcons";
import { SocketBoundary } from "./SocketBoundary";
import {
  SocketIcon,
  SocketMenuRow,
  SocketMenuSubRows,
  SocketOverflow,
  SocketSplitGroup,
  SocketSplitMenu,
  socketTintStyle,
} from "./socketUi";

/**
 * Contributed buttons in the chat composer's accessory row.
 *
 * Two visible with the rest behind a "+N", the same restraint as toolbar
 * actions and row badges: the accessory row is where the user reaches for
 * attach, dictate and send, and a plugin joins that row rather than pushing the
 * product's own controls off it.
 *
 * The draft is read at CLICK time, through `readDraft`, not captured at render.
 * A composer's draft changes on every keystroke, and a context built during
 * render would either be stale by the time the button was pressed or force this
 * row to re-render on every character typed. What the component holds instead
 * is the composer's identity, which changes when the chat does and not before.
 */

/** Plugin buttons never crowd out the composer's own; beyond this they fold away. */
const VISIBLE_LIMIT = 2;

/** Matches the accessory row's own icon buttons — see `AgentChatComposer`. */
const BUTTON_BASE =
  "inline-flex h-7 max-w-[132px] shrink-0 items-center gap-1 px-1.5"
  + " font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/45"
  + " transition-colors hover:bg-violet-500/[0.06] hover:text-violet-300/60"
  + " disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";

/** A button with no menu: the rounded pill the accessory row always drew. */
const BUTTON_CLASS = `${BUTTON_BASE} rounded-lg`;

/**
 * The primary half of a split button: left corners only.
 *
 * These are ghost buttons with no border of their own, so the seam is the
 * chevron's hairline `border-l` rather than a shared outline — but the
 * arrangement is the chat header's exactly: no gap, one radius across the pair,
 * and the pressable areas butted together so the control reads as one.
 */
const BUTTON_SPLIT_CLASS = `${BUTTON_BASE} rounded-l-lg`;

/**
 * Running, and the button says so by looking ON rather than dimmed.
 *
 * A composer action can legitimately run for minutes — recording, transcribing,
 * generating — and the user watches this button for the whole of it. Greying it
 * out the way a `disabled` control looks would read as "broken" a few seconds
 * in. So a running button holds the accent the row uses for active state, keeps
 * its label, and stays focusable; what it does NOT do is fire again.
 */
const BUTTON_BUSY_CLASS =
  "bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)]"
  + " text-[var(--chat-accent)] hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)]"
  + " hover:text-[var(--chat-accent)]";

/**
 * The chevron half, sized to the accessory row rather than to a toolbar.
 *
 * The divider is `fg`-alpha rather than white-alpha: it is the seam of a joined
 * control, so it has to be visible in BOTH themes, and `--color-fg` flips with
 * the theme where a white wash only reads on dark.
 */
const CHEVRON_CLASS =
  "inline-flex h-7 shrink-0 items-center rounded-r-lg border-l border-fg/[0.10] px-1"
  + " text-muted-fg/45 transition-colors hover:bg-violet-500/[0.06] hover:text-violet-300/60";

/**
 * The composer-action currently claiming Send, when one is armed.
 *
 * `ownsSend` is a toggle, not an invoke: the button looks ON, and Enter/Send
 * invokes this action with `args.send === true` instead of the local runtime.
 * Null means Send is ADE's own.
 */
export type PluginComposerSendOwner = {
  pluginId: string;
  actionId: string;
  label: string;
} | null;

export function PluginComposerActions({
  surface = "work",
  sessionId,
  projectKey = null,
  projectRoot = null,
  laneId = null,
  readDraft,
  readComposerState,
  sendOwner = null,
  onSendOwnerChange,
  active = true,
}: {
  /** The core surface the composer lives on. Only Work has one today. */
  surface?: PluginSurfaceId;
  /** Null on a composer that has not started a chat yet. */
  sessionId: string | null;
  projectKey?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
  /** Reads the live draft and caret. Must be stable — it is called on click. */
  readDraft: () => { draft: string; cursor: number | null };
  /**
   * Model / effort / speed as they read at invoke time.
   *
   * Optional so a composer that has no model row still contributes buttons.
   * Spread onto the context next to the live draft.
   */
  readComposerState?: () => {
    modelId: string | null;
    reasoningEffort: string | null;
    fastMode: boolean | null;
  };
  /** Which ownsSend contribution currently claims Enter/Send. */
  sendOwner?: PluginComposerSendOwner;
  /** Arm or disarm an ownsSend contribution. Absent, ownsSend clicks invoke. */
  onSendOwnerChange?: (owner: PluginComposerSendOwner) => void;
  active?: boolean;
}) {
  /**
   * The identity half of the context, with the draft left empty.
   *
   * This is what selects contributions (which only ever reads the session) and
   * what the click handler spreads the live draft over.
   */
  const identity = React.useMemo<PluginComposerContext>(
    () => ({
      kind: "composer",
      sessionId,
      projectKey,
      projectRoot,
      laneId,
      draft: "",
      cursor: null,
    }),
    [laneId, projectKey, projectRoot, sessionId],
  );
  // Filed per SESSION: `surface` names the tab this kind is declared on, while
  // the composer context resolves to a `{entityKind: "session"}` key and skips
  // the surface fallback — so a plugin publishes a per-chat row to change what
  // this button says in one conversation. See `useSurfaceContributions`.
  const contributions = useSurfaceContributions(surface, "composer-action", {
    active,
    context: identity,
  });
  const invoke = usePluginSocketInvoke();
  const brandIconsFor = usePluginBrandIcons();
  const [busyKeys, setBusyKeys] = React.useState<readonly string[]>([]);

  /**
   * Disarm a Send owner whose contribution is no longer on the row.
   *
   * The armed owner lives in the parent composer, and the parent cannot see
   * this row's contributions. So a plugin that was disabled, uninstalled, or
   * whose per-session row stopped declaring `ownsSend` removed the button here
   * and left the parent armed — Enter then dispatched a plugin action for a
   * button nobody could see, instead of sending the turn to the local runtime.
   *
   * Gated on `active`, because an inactive composer reads an EMPTY set rather
   * than a set that says the contribution is gone. Disarming on that would
   * clear the arm every time the pane lost focus.
   */
  React.useEffect(() => {
    if (!active || !sendOwner || !onSendOwnerChange) return;
    const live = contributions.some((entry) => (
      entry.payload.ownsSend === true
      && entry.pluginId === sendOwner.pluginId
      && entry.payload.actionId === sendOwner.actionId
    ));
    if (!live) onSendOwnerChange(null);
  }, [active, contributions, onSendOwnerChange, sendOwner]);

  /**
   * Fire an action, unless this one is already running.
   *
   * The re-entry guard is here rather than on the button's `disabled`, because
   * a long action has to stay visibly active AND focusable while it runs. The
   * check reads the state that the same click just set, so a double-click and a
   * keyboard repeat both collapse to one invocation.
   */
  const busyKeysRef = React.useRef<readonly string[]>(busyKeys);
  busyKeysRef.current = busyKeys;
  const run = React.useCallback((pluginId: string, actionId: string, key: string) => {
    if (busyKeysRef.current.includes(key)) return;
    busyKeysRef.current = [...busyKeysRef.current, key];
    setBusyKeys(busyKeysRef.current);
    void invoke(
      pluginId,
      actionId,
      { ...identity, ...readDraft(), ...(readComposerState?.() ?? {}) },
      { socket: "composer-action" },
    )
      .finally(() => setBusyKeys((keys) => keys.filter((entry) => entry !== key)));
  }, [identity, invoke, readComposerState, readDraft]);

  const press = React.useCallback((
    contribution: { pluginId: string; payload: { actionId: string; label: string; ownsSend?: boolean } },
    key: string,
  ) => {
    if (contribution.payload.ownsSend === true && onSendOwnerChange) {
      const armed = sendOwner?.pluginId === contribution.pluginId
        && sendOwner?.actionId === contribution.payload.actionId;
      onSendOwnerChange(armed
        ? null
        : {
          pluginId: contribution.pluginId,
          actionId: contribution.payload.actionId,
          label: contribution.payload.label,
        });
      return;
    }
    run(contribution.pluginId, contribution.payload.actionId, key);
  }, [onSendOwnerChange, run, sendOwner]);

  if (contributions.length === 0) return null;

  /**
   * A running action is always on screen, whatever the host order says.
   *
   * Pressed from the overflow popover, an action would otherwise start a
   * minutes-long recording behind a "+N" that says nothing — the popover closes
   * and the only feedback is a menu row nobody is looking at. Promoting it is
   * the one reordering this row does, it lasts exactly as long as the run, and
   * it puts the active state where the user is already looking.
   */
  const running = contributions.filter((entry) => busyKeys.includes(contributionKey(entry)));
  const armed = contributions.filter((entry) => (
    entry.payload.ownsSend === true
    && sendOwner?.pluginId === entry.pluginId
    && sendOwner?.actionId === entry.payload.actionId
    && !busyKeys.includes(contributionKey(entry))
  ));
  const idle = contributions.filter((entry) => (
    !busyKeys.includes(contributionKey(entry))
    && !(
      entry.payload.ownsSend === true
      && sendOwner?.pluginId === entry.pluginId
      && sendOwner?.actionId === entry.payload.actionId
    )
  ));
  const ordered = (running.length > 0 || armed.length > 0)
    ? [...running, ...armed, ...idle]
    : contributions;
  const visible = ordered.slice(0, VISIBLE_LIMIT);
  const hidden = ordered.slice(VISIBLE_LIMIT);
  const dataTour = `plugin:${surface}.composer-action`;

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {visible.map((contribution) => {
        const key = contributionKey(contribution);
        const busy = busyKeys.includes(key);
        const claimed = contribution.payload.ownsSend === true
          && sendOwner?.pluginId === contribution.pluginId
          && sendOwner?.actionId === contribution.payload.actionId;
        const lit = busy || claimed;
        const menu = contribution.payload.menu ?? [];
        const split = menu.length > 0;
        /* A running or armed button keeps the platform's busy chrome rather than
           the plugin's tint: inline styles outrank classes, so painting the
           colour here would paint over the only signal that says it is on. */
        const tint = lit ? {} : socketTintStyle(contribution.payload.color);
        const base = split ? BUTTON_SPLIT_CLASS : BUTTON_CLASS;
        const title = busy
          ? `${contribution.payload.label} — running…`
          : claimed
            ? `${contribution.payload.label} — Send launches here. Press to turn off.`
            : contribution.payload.label;
        return (
          <SocketBoundary key={key}>
            <SocketSplitGroup>
              <button
                type="button"
                data-tour={dataTour}
                data-busy={busy || undefined}
                className={lit ? `${base} ${BUTTON_BUSY_CLASS}` : base}
                style={tint}
                title={title}
                aria-busy={busy || undefined}
                aria-pressed={contribution.payload.ownsSend === true ? claimed : undefined}
                // Only the plugin's own `disabled` greys the button out. A running
                // one stays enabled and refuses re-entry in `run` instead — see
                // BUTTON_BUSY_CLASS for why a minutes-long action must not look
                // like a dead control.
                disabled={contribution.payload.disabled === true}
                onClick={() => press(contribution, key)}
              >
                <SocketIcon
                  name={contribution.payload.icon}
                  size={12}
                  {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                />
                <span className="truncate">{contribution.payload.label}</span>
              </button>
              {/* Menu actions share the BUTTON's busy key on purpose: the two
                  halves are one control, so a menu action that records for two
                  minutes lights the button the user is looking at and refuses a
                  second press from either half. Menu items still invoke — they
                  are Advanced, not the Send claim. */}
              <SocketSplitMenu
                items={menu}
                label={contribution.payload.label}
                {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                dataTour={`${dataTour}-menu`}
                className={lit ? `${CHEVRON_CLASS} ${BUTTON_BUSY_CLASS}` : CHEVRON_CLASS}
                style={tint}
                onSelect={(item) => run(contribution.pluginId, item.actionId, key)}
              />
            </SocketSplitGroup>
          </SocketBoundary>
        );
      })}
      {hidden.length > 0 ? (
        <SocketOverflow
          count={hidden.length}
          label={`${hidden.length} more plugin actions`}
          dataTour={`${dataTour}-overflow`}
        >
          {hidden.map((contribution) => {
            const key = contributionKey(contribution);
            return (
              <SocketBoundary key={key}>
                <SocketMenuRow
                  label={contribution.payload.label}
                  {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
                  {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                  onClick={() => press(contribution, key)}
                />
                <SocketMenuSubRows
                  items={contribution.payload.menu ?? []}
                  {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                  onSelect={(item) => run(contribution.pluginId, item.actionId, key)}
                />
              </SocketBoundary>
            );
          })}
        </SocketOverflow>
      ) : null}
    </span>
  );
}
