/**
 * One agent, on its own.
 *
 * The `agent` surface is what a deeplink and the chat header's "open this cloud
 * run" land on. It draws the SAME `AgentDetail` the fleet embeds as its right
 * pane — not a second copy of it — which is why that component takes an
 * `agentId` prop rather than reading the page context for itself.
 *
 * With no agent named there is nothing to draw, and an empty pane would be a
 * dead end. The fleet is drawn instead: a reader who arrived here without an
 * agent is a reader who wanted the list.
 */

import React from "react";

import type { PluginWebviewContext } from "../bridge";
import { AgentDetail } from "../components/AgentDetail";
import { Fleet } from "../components/Fleet";
import { readAgentId } from "../lib/subject";

export function AgentEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const agentId = readAgentId(context);
  if (!agentId) {
    return <Fleet projectRoot={context.project?.root ?? null} />;
  }
  // No `onClose`: this placement IS the agent, so there is no pane to close
  // back to — the host's own chrome closes it.
  return <AgentDetail agentId={agentId} />;
}
