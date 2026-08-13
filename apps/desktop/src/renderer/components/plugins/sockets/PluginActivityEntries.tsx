import React from "react";

import { ActivitySectionHeader } from "../../activity/ActivitySectionHeader";
import { useActivitySectionCollapse } from "../../activity/activitySectionCollapse";
import { cn } from "../../ui/cn";
import { selectActiveProjectStateKey, useAppStore } from "../../../state/appStore";
import type { PluginActivityContext } from "../../../../shared/plugins/context";
import type { PluginBadgeTone } from "../../../../shared/plugins/sockets";
import { contributionKey } from "./contributionModel";
import { runPluginSocketAction } from "./pluginActionDispatch";
import { SocketBoundary } from "./SocketBoundary";
import { SocketIcon } from "./socketUi";
import { usePluginSurfaceContributions, useSurfaceContributions } from "./useSurfaceContributions";

/**
 * The `activity-entry` socket: a plugin's rows in the Activity pane.
 *
 * The one place a plugin can say "this needs you" without inventing a
 * notification. A cost guard that has tripped, a linter with findings, a
 * deploy waiting on approval — all of them previously had to badge a row the
 * user might never scroll to, or borrow `session.requestSessionAttention` and
 * push an unattributed message to every paired phone.
 *
 * Entries are read from the same `plugin_contributions` table as every other
 * socket, which is what makes them ephemeral in the right way: a plugin
 * publishes a row when something needs attention and deletes it when it stops,
 * and an uninstall takes its rows with it. There is deliberately no per-row
 * dismiss — dismissing ADE's own activity acknowledges a fact the host owns,
 * while a plugin's row is the plugin's own state, and a dismiss that the next
 * publish undid would read as the button not working.
 */

/**
 * Vocabulary tone → the Activity pane's colour vocabulary.
 *
 * Two closed sets that mean the same four things by different names. The pane
 * speaks in colours because its own rows are typed by event kind, and the
 * socket taxonomy speaks in tones because a plugin should not be picking
 * colours. Nothing maps to red: `PluginBadgeTone` has no red, deliberately, so
 * a plugin cannot make its row the loudest thing in a list it does not own.
 */
const ACTIVITY_TONE_CLASS: Record<PluginBadgeTone, string> = {
  neutral: "neutral",
  accent: "violet",
  success: "emerald",
  warning: "amber",
};

const SECTION_ID = "notifications:plugins";

const SECTION_REGION_ID = "activity-notifications-plugins";

/**
 * How many rows plugins have contributed.
 *
 * Exists so the column can tell "Inbox zero" apart from "ADE has nothing but a
 * plugin does". Claiming inbox zero over a plugin's raised hand would be the
 * pane lying about the only thing it is for. The store behind both this and the
 * component is shared and memoized per surface, so asking twice costs one read.
 */
export function usePluginActivityEntryCount(active = true): number {
  return useSurfaceContributions("app", "activity-entry", { active }).length;
}

/**
 * Contributed activity rows, as a collapsible section after the pane's own.
 *
 * Rendered inside the Notifications column's scroll container, which is why it
 * emits a section header and rows rather than a column of its own: a plugin
 * joins the list of things waiting on you, it does not open a third column
 * beside "what is running" and "what is waiting".
 */
export function PluginActivityEntries({ active = true }: { active?: boolean }) {
  const projectKey = useAppStore(selectActiveProjectStateKey);
  const laneId = useAppStore((state) => state.selectedLaneId);
  const contributions = useSurfaceContributions("app", "activity-entry", { active });
  const { identities } = usePluginSurfaceContributions("app", active);
  const collapse = useActivitySectionCollapse("pane");
  const [pendingKey, setPendingKey] = React.useState<string | null>(null);

  const invoke = React.useCallback((entryId: string, pluginId: string, actionId: string, key: string) => {
    // `entryId` is the plugin's own contribution id, and it is the only thing
    // the handler cannot work out for itself: a plugin routinely publishes
    // several rows that share one action, and "which row" is the question.
    const context: PluginActivityContext = { kind: "activity", entryId, projectKey, laneId };
    setPendingKey(key);
    void runPluginSocketAction(pluginId, actionId, context, { socket: "activity-entry" })
      .finally(() => setPendingKey((current) => (current === key ? null : current)));
  }, [laneId, projectKey]);

  if (contributions.length === 0) return null;

  const collapsed = collapse.isCollapsed(SECTION_ID);

  return (
    <>
      <ActivitySectionHeader
        variant="pane"
        sectionId={SECTION_ID}
        regionId={SECTION_REGION_ID}
        label="From plugins"
        count={contributions.length}
        collapsed={collapsed}
        onToggle={() => collapse.toggle(SECTION_ID)}
      />
      <div
        id={SECTION_REGION_ID}
        className="activity-section-rows"
        data-tour="plugin:app.activity-entry"
        hidden={collapsed}
      >
        {collapsed ? null : contributions.map((contribution) => {
          const key = contributionKey(contribution);
          const { title, body, tone, actionId, actionLabel } = contribution.payload;
          const name = identities.get(contribution.pluginId)?.displayName ?? contribution.pluginId;
          // The plugin's name is always on the row. These sit among rows about
          // the user's own pull requests and failing checks, and one that did
          // not say whose it was would read as ADE's own claim about their work.
          const detail = body ? `${body} · ${name}` : name;
          const inner = (
            <>
              <span className="activity-inbox-icon" aria-hidden>
                <SocketIcon size={13} />
              </span>
              <span className="activity-inbox-copy">
                <strong>{title}</strong>
                <span>{detail}</span>
              </span>
            </>
          );
          return (
            <SocketBoundary key={key}>
              <div className={cn("activity-inbox-row", `activity-tone-${ACTIVITY_TONE_CLASS[tone]}`)}>
                {actionId ? (
                  <button
                    type="button"
                    className="activity-inbox-open"
                    aria-busy={pendingKey === key ? true : undefined}
                    disabled={pendingKey === key}
                    title={actionLabel ? `${actionLabel} — ${name}` : `${title} — ${name}`}
                    onClick={() => invoke(contribution.id, contribution.pluginId, actionId, key)}
                  >
                    {inner}
                  </button>
                ) : (
                  // No action means nothing to press. Drawing it as a button
                  // anyway would make a status line look like a control that
                  // had stopped working.
                  <div className="activity-inbox-open" title={`${title} — ${name}`}>
                    {inner}
                  </div>
                )}
              </div>
            </SocketBoundary>
          );
        })}
      </div>
    </>
  );
}
