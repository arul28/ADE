import React from "react";

import type { PluginSessionContext } from "../../../../shared/plugins/context";
import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import { contributionKey } from "./contributionModel";
import { usePluginSocketInvoke, useSurfaceContributions } from "./useSurfaceContributions";
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
 * Contributed buttons in an open chat's header.
 *
 * The one placement the plugin alpha test asked for by name and did not get.
 * The user described a control in the chat's header; the platform's nearest
 * seam was the composer accessory row, so the plugin appeared below the
 * conversation instead of above it — and, because a composer with no chat yet
 * still renders, appeared in a *new* pane while the conversation they were
 * actually having showed nothing. This mounts on the header every work surface
 * shares, so an existing chat carries it, a CLI session carries it, and a grid
 * tile carries it, all from one declaration.
 *
 * What separates it from the `toolbar-action` sitting a few pixels away in the
 * same row is the CONTEXT, not the chrome: that one receives the Work tab,
 * this one receives the chat. A plugin acting on *this conversation* could not
 * do it from the toolbar kind without the host guessing which chat was meant.
 *
 * Busy state is the composer button's, for the same reason it exists there: a
 * header action's canonical uses — summarize this chat, hand it off, file it —
 * are open-ended, so the socket carries the long invoke budget and the button
 * has to show the user it is working for the whole of it.
 */

/** Plugin buttons never crowd out the header's own; beyond this they fold away. */
const VISIBLE_LIMIT = 2;

/**
 * Mirrors `WORK_SURFACE_HEADER_ACTION_BASE` + `_IDLE` in `../work/WorkSurfaceHeader`.
 *
 * Restated rather than imported: that module imports this one's barrel, and a
 * cycle for two class strings would trade a real initialization hazard for a
 * saved line. Kept adjacent in review by this comment, the way
 * `PluginComposerActions` restates the accessory row's own button chrome.
 */
const BUTTON_BASE =
  "relative inline-flex h-6 max-w-[140px] shrink-0 items-center gap-1 px-2"
  + " font-sans text-[10px] font-medium transition-colors"
  + " border-white/[0.06] bg-white/[0.02] text-muted-fg/40 hover:border-white/[0.10] hover:text-fg/65"
  + " disabled:cursor-default disabled:opacity-50 disabled:hover:border-white/[0.06]";

/** A button with no menu: four corners, four edges. */
const BUTTON_CLASS = `${BUTTON_BASE} rounded-md border`;

/**
 * The primary half of a split button: left corners, and no right EDGE.
 *
 * The seam belongs to the chevron's left border, so the joint is one hairline
 * rather than two butted against each other. Radius and edges are named
 * per-side instead of layering `rounded-r-none` over `rounded-md`, which would
 * make the joint depend on Tailwind's utility ordering.
 */
const BUTTON_SPLIT_CLASS = `${BUTTON_BASE} rounded-l-md border-y border-l`;

/**
 * Running, and the button says so by looking ON rather than dimmed — see
 * `PluginComposerActions`, which learned this the same way: a control greyed
 * out for the two minutes it is legitimately working reads as broken.
 *
 * Worn by BOTH halves of a split button, because the busy state is the
 * contribution's: lighting only the left half of one control while its own
 * chevron stayed grey would say the two are separate things, which is exactly
 * the reading the joint above exists to remove.
 */
const BUTTON_BUSY_CLASS =
  "border-violet-400/25 bg-violet-500/[0.10] text-violet-200/80"
  + " hover:border-violet-400/35 hover:text-violet-100";

/** The chevron half of a split button, sized to the 24px header row. */
const CHEVRON_CLASS =
  "inline-flex h-6 shrink-0 items-center rounded-r-md border border-white/[0.06]"
  + " bg-white/[0.02] px-1 text-muted-fg/40 transition-colors"
  + " hover:border-white/[0.10] hover:text-fg/65";

export function PluginChatHeaderActions({
  surface = "work",
  session,
  active = true,
}: {
  /** The core surface the chat lives on. Only Work has one today. */
  surface?: PluginSurfaceId;
  /**
   * The chat this header belongs to, or null.
   *
   * Null keeps the row inert: a header with no session — a pane that has not
   * started a chat — has no subject to hand a plugin, and a button invoked
   * against nothing is worse than an absent button.
   */
  session: PluginSessionContext | null;
  active?: boolean;
}) {
  /**
   * Filed per SESSION, not per surface — the two arguments below say different
   * things.
   *
   * `surface` names the tab this kind is declared on, which is what selects the
   * manifest declarations and loads the rows. `context` names the entity whose
   * rows are then read out of them. Passing a session context makes
   * `selectContributions` resolve a `{entityKind: "session"}` key and skip the
   * surface fallback completely, so a plugin publishes a per-chat row to change
   * what this button says in one conversation — exactly as `composer-action`
   * does, and NOT as the `toolbar-action` two lines down in the same header,
   * which passes a surface-only context and is filed against the tab.
   *
   * Spelled out because the call is one argument away from the toolbar version
   * and was already read as surface-scoped once, by a client that then filed it
   * against the tab: per-chat rows would have rendered here and nowhere on the
   * phone, and tab-scoped rows the reverse. See the rule on
   * `useSurfaceContributions` and the pin in `contributionModel.test.ts`.
   */
  const contributions = useSurfaceContributions(surface, "chat-header-action", {
    active: active && session !== null,
    context: session,
  });
  const invoke = usePluginSocketInvoke();
  const [busyKeys, setBusyKeys] = React.useState<readonly string[]>([]);

  /**
   * Fire an action, unless this one is already running.
   *
   * The guard reads the state the same click just set, so a double-click and a
   * keyboard repeat collapse to one invocation. It lives here rather than on
   * `disabled` because a long action must stay visibly active and focusable.
   */
  const busyKeysRef = React.useRef<readonly string[]>(busyKeys);
  busyKeysRef.current = busyKeys;
  const run = React.useCallback((pluginId: string, actionId: string, key: string) => {
    if (!session) return;
    if (busyKeysRef.current.includes(key)) return;
    busyKeysRef.current = [...busyKeysRef.current, key];
    setBusyKeys(busyKeysRef.current);
    void invoke(pluginId, actionId, session, { socket: "chat-header-action" })
      .finally(() => setBusyKeys((keys) => keys.filter((entry) => entry !== key)));
  }, [invoke, session]);

  if (!session || contributions.length === 0) return null;

  /**
   * A running action is always on screen, whatever the host order says — the
   * same promotion `PluginComposerActions` does, for the same reason: an action
   * started from behind a "+N" would otherwise run for minutes with its only
   * feedback inside a popover that closed when it was pressed.
   */
  const running = contributions.filter((entry) => busyKeys.includes(contributionKey(entry)));
  const idle = contributions.filter((entry) => !busyKeys.includes(contributionKey(entry)));
  const ordered = running.length > 0 ? [...running, ...idle] : contributions;
  const visible = ordered.slice(0, VISIBLE_LIMIT);
  const hidden = ordered.slice(VISIBLE_LIMIT);
  const dataTour = `plugin:${surface}.chat-header-action`;

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {visible.map((contribution) => {
        const key = contributionKey(contribution);
        const busy = busyKeys.includes(key);
        const menu = contribution.payload.menu ?? [];
        const split = menu.length > 0;
        /* The platform's own busy chrome outranks a plugin's tint, and inline
           styles outrank classes — so a running button drops the colour rather
           than painting over the one signal that says it is working. */
        const tint = busy ? {} : socketTintStyle(contribution.payload.color);
        const base = split ? BUTTON_SPLIT_CLASS : BUTTON_CLASS;
        return (
          <SocketBoundary key={key}>
            <SocketSplitGroup>
              <button
                type="button"
                data-tour={dataTour}
                data-busy={busy || undefined}
                className={busy ? `${base} ${BUTTON_BUSY_CLASS}` : base}
                style={tint}
                title={busy ? `${contribution.payload.label} — running…` : contribution.payload.label}
                aria-busy={busy || undefined}
                disabled={contribution.payload.disabled === true}
                onClick={() => run(contribution.pluginId, contribution.payload.actionId, key)}
              >
                <SocketIcon name={contribution.payload.icon} size={11} />
                <span className="truncate">{contribution.payload.label}</span>
              </button>
              {/* Menu actions share the button's busy key: two halves, one control. */}
              <SocketSplitMenu
                items={menu}
                label={contribution.payload.label}
                dataTour={`${dataTour}-menu`}
                className={busy ? `${CHEVRON_CLASS} ${BUTTON_BUSY_CLASS}` : CHEVRON_CLASS}
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
