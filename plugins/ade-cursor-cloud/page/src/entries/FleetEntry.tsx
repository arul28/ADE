/**
 * The fleet, in whichever placement asked for it.
 *
 * The rail tab, the Work-rail pane and the phone all land here, and none of
 * them needs a different tree: the page fills its placement and the layout
 * inside it is driven by the placement's WIDTH, never by which placement it is
 * and never by a user agent.
 *
 * The one thing this entry owns that the fleet does not is the unread badge.
 */

import React, { useEffect } from "react";

import type { PluginWebviewContext } from "../bridge";
import { Fleet } from "../components/Fleet";
import { ackBadge } from "../host/actions";
import { readAgentId } from "../lib/subject";

export function FleetEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  /**
   * The badge, acknowledged as a refcount.
   *
   * `CursorCloudQuickViewButton` zeroed its unread counter when its modal
   * opened, because there was exactly one modal and it was the only way to see
   * the fleet. There is no longer exactly one: the rail tab, the Work-rail pane
   * and a phone can all be mounted at once, and the tab badge must stay lit
   * while any of them is hidden and go out only when the last visible one goes.
   * Only the child can know that, so the page reports arrival and departure and
   * the child keeps the count.
   *
   * The cleanup is fire-and-forget on purpose. It runs while the placement is
   * being torn down, and awaiting a bridge call at that moment is awaiting a
   * channel that may already be closing — a leaked "+1" is a badge that stays
   * lit one refresh too long, which is strictly better than a teardown that
   * throws.
   */
  useEffect(() => {
    void ackBadge(true).catch(() => {});
    return () => {
      void ackBadge(false).catch(() => {});
    };
  }, []);

  return (
    <Fleet
      projectRoot={context.project?.root ?? null}
      initialAgentId={readAgentId(context)}
    />
  );
}
