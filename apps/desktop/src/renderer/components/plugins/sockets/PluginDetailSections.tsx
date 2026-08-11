import React from "react";

import { COLORS, SECTION_LABEL_STYLE } from "../../lanes/laneDesignTokens";
import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import { PluginPanelHost } from "../PluginPanelHost";
import { contributionKey } from "./contributionModel";
import { useSurfaceContributions } from "./useSurfaceContributions";
import { SocketBoundary } from "./SocketBoundary";

/**
 * Contributed detail sections — a plugin's vocabulary panel, rendered inside a
 * surface's detail pane after the product's own sections.
 *
 * `active` is threaded all the way down to `PluginPanelHost` rather than being
 * used to skip the render, because a collapsed or backgrounded pane is still
 * mounted in this app: the panel must exist and cost nothing, not disappear and
 * re-fetch on every expand.
 */
export function PluginDetailSections({
  surface,
  context,
  active = true,
  showTitles = true,
}: {
  surface: PluginSurfaceId;
  context: PluginSurfaceContext;
  active?: boolean;
  /** Off where the host already draws a header for the section. */
  showTitles?: boolean;
}) {
  const contributions = useSurfaceContributions(surface, "detail-section", { active, context });
  if (contributions.length === 0) return null;

  return (
    <div
      data-tour={`plugin:${surface}.detail-section`}
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {contributions.map((contribution) => {
        const title = contribution.payload.title;
        return (
          <SocketBoundary key={contributionKey(contribution)}>
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {showTitles && title ? (
                <header style={{ ...SECTION_LABEL_STYLE, color: COLORS.textMuted }}>{title}</header>
              ) : null}
              <PluginPanelHost
                pluginId={contribution.pluginId}
                panelId={contribution.payload.panelId}
                active={active}
                surfaceContext={context}
              />
            </section>
          </SocketBoundary>
        );
      })}
    </div>
  );
}
