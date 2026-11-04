import React, { type ReactNode } from "react";
import type { McpRegistryServer } from "../../../../shared/mcpRegistry";
import { mcpServerRunsLabel, mcpServerRunsLine } from "../../../../shared/mcpServerRequest";
import "./mcpRunsLine.css";

/**
 * What a server will run (its command line) or reach (its URL), on one mono
 * line the person reads before they add it.
 */
export function McpRunsLine({
  server,
  line,
  inline = false,
  children,
}: {
  server: McpRegistryServer;
  /** The line to show; absent: built from the server. */
  line?: string;
  /** It shares a row with the button. */
  inline?: boolean;
  /** Shown after the line (where it was found). */
  children?: ReactNode;
}) {
  return (
    <div className="ade-mcpc-runs" data-inline={inline || undefined} data-testid="mcp-server-runs">
      <span className="ade-mcpc-runs-label">{mcpServerRunsLabel(server)}</span>
      <code className="ade-mcpc-runs-line">{line ?? mcpServerRunsLine(server)}</code>
      {children}
    </div>
  );
}
