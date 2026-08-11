import React from "react";

import { COLORS, RADII, SANS_FONT } from "../../../lanes/laneDesignTokens";
import { PluginPanelHost } from "../../../plugins/PluginPanelHost";
import { parsePluginViewerKind } from "../../../plugins/sockets/contributionModel";
import { usePluginFileViewers } from "../../../plugins/sockets/useSurfaceContributions";
import { pluginFileExtension, type PluginFileContext } from "../../../../../shared/plugins/context";
import { BinaryViewer } from "./BinaryViewer";
import type { ViewerProps } from "./types";

/**
 * A file rendered by a plugin's vocabulary panel.
 *
 * What a viewer panel can bind, stated once so plugin authors are not guessing:
 *
 * - **The file's identity**, as a `PluginFileContext` (`workspaceId`, `path`,
 *   `size`, `extension`), attached to every action the panel dispatches. That
 *   is how a panel knows *which* file it is showing.
 * - **Its own collections**, exactly as on any other panel — this is where a
 *   viewer puts anything it computed about the file.
 *
 * What it does not get is the bytes themselves. A vocabulary schema is capped at
 * 64 KiB and is *data*, not a buffer; forwarding a file through it would break on
 * the first real video. A plugin that needs the bytes reads them on its own
 * machine through the SDK, where it can stream.
 */
export function PluginViewer(props: ViewerProps) {
  const { tab, content, workspaceId } = props;
  const registrations = usePluginFileViewers();
  const parsed = parsePluginViewerKind(tab.viewerKind);

  const stillInstalled = Boolean(
    parsed
    && registrations.some(
      (entry) => entry.pluginId === parsed.pluginId && entry.panelId === parsed.panelId,
    ),
  );

  const surfaceContext = React.useMemo<PluginFileContext>(
    () => ({
      kind: "file",
      path: tab.path,
      // `totalSize` is the real length when the host only loaded a first chunk;
      // `size` alone would tell a plugin a 2 GB video is 256 KB.
      size: content.totalSize ?? content.size,
      extension: pluginFileExtension(tab.path),
      workspaceId,
    }),
    [content.size, content.totalSize, tab.path, workspaceId],
  );

  // A tab can outlive the plugin that opened it: viewer kinds are persisted in
  // the editor session, and uninstalling happens while the workbench is closed.
  // The file still opens — in the honest binary fallback — with a line saying
  // why it does not look the way it did yesterday.
  if (!parsed || !stillInstalled) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div
          role="status"
          style={{
            margin: 12,
            padding: "8px 10px",
            fontFamily: SANS_FONT,
            fontSize: 11,
            color: COLORS.textMuted,
            background: "color-mix(in srgb, var(--color-warning) 8%, transparent)",
            border: `1px solid color-mix(in srgb, var(--color-warning) 22%, transparent)`,
            borderRadius: RADII.sm,
          }}
        >
          The viewer for this file came from a plugin that is no longer installed — showing the
          built-in view instead.
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <BinaryViewer {...props} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 16 }}>
      <PluginPanelHost
        pluginId={parsed.pluginId}
        panelId={parsed.panelId}
        active
        surfaceContext={surfaceContext}
      />
    </div>
  );
}
