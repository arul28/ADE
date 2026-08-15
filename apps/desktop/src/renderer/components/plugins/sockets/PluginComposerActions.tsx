import React from "react";

import type { PluginComposerContext } from "../../../../shared/plugins/context";
import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import { contributionKey } from "./contributionModel";
import { usePluginSocketInvoke, useSurfaceContributions } from "./useSurfaceContributions";
import { SocketBoundary } from "./SocketBoundary";
import {
  SocketIcon,
  SocketMenuRow,
  SocketMenuSubRows,
  SocketOverflow,
  SocketSplitMenu,
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
const BUTTON_CLASS =
  "inline-flex h-7 max-w-[132px] shrink-0 items-center gap-1 rounded-lg px-1.5"
  + " font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/45"
  + " transition-colors hover:bg-violet-500/[0.06] hover:text-violet-300/60"
  + " disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";

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

/** The chevron half, sized to the accessory row rather than to a toolbar. */
const CHEVRON_CLASS =
  "inline-flex h-7 shrink-0 items-center rounded-lg px-0.5 text-muted-fg/45"
  + " transition-colors hover:bg-violet-500/[0.06] hover:text-violet-300/60";

export function PluginComposerActions({
  surface = "work",
  sessionId,
  projectKey = null,
  projectRoot = null,
  laneId = null,
  readDraft,
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
  const [busyKeys, setBusyKeys] = React.useState<readonly string[]>([]);

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
    void invoke(pluginId, actionId, { ...identity, ...readDraft() }, { socket: "composer-action" })
      .finally(() => setBusyKeys((keys) => keys.filter((entry) => entry !== key)));
  }, [identity, invoke, readDraft]);

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
  const idle = contributions.filter((entry) => !busyKeys.includes(contributionKey(entry)));
  const ordered = running.length > 0 ? [...running, ...idle] : contributions;
  const visible = ordered.slice(0, VISIBLE_LIMIT);
  const hidden = ordered.slice(VISIBLE_LIMIT);
  const dataTour = `plugin:${surface}.composer-action`;

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {visible.map((contribution) => {
        const key = contributionKey(contribution);
        const busy = busyKeys.includes(key);
        const menu = contribution.payload.menu ?? [];
        return (
          <SocketBoundary key={key}>
            <button
              type="button"
              data-tour={dataTour}
              data-busy={busy || undefined}
              className={busy ? `${BUTTON_CLASS} ${BUTTON_BUSY_CLASS}` : BUTTON_CLASS}
              title={busy ? `${contribution.payload.label} — running…` : contribution.payload.label}
              aria-busy={busy || undefined}
              // Only the plugin's own `disabled` greys the button out. A running
              // one stays enabled and refuses re-entry in `run` instead — see
              // BUTTON_BUSY_CLASS for why a minutes-long action must not look
              // like a dead control.
              disabled={contribution.payload.disabled === true}
              onClick={() => run(contribution.pluginId, contribution.payload.actionId, key)}
            >
              <SocketIcon name={contribution.payload.icon} size={12} />
              <span className="truncate">{contribution.payload.label}</span>
            </button>
            {/* Menu actions share the BUTTON's busy key on purpose: the two
                halves are one control, so a menu action that records for two
                minutes lights the button the user is looking at and refuses a
                second press from either half. */}
            <SocketSplitMenu
              items={menu}
              label={contribution.payload.label}
              dataTour={`${dataTour}-menu`}
              className={CHEVRON_CLASS}
              onSelect={(item) => run(contribution.pluginId, item.actionId, key)}
            />
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
                  onClick={() => run(contribution.pluginId, contribution.payload.actionId, key)}
                />
                <SocketMenuSubRows
                  items={contribution.payload.menu ?? []}
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
