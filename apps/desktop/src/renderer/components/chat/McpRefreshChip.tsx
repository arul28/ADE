import React from "react";
import { Plugs } from "@phosphor-icons/react";

import type { OpenProjectBinding } from "../../../shared/types";
import { restartAgentSession } from "../terminals/sessionLifecycleActions";
import { StatusChip } from "../ui/notice/StatusChip";

/**
 * "New MCP server added · Refresh chat", in the composer's status row.
 *
 * A running chat keeps the MCP servers its agent started with. When the
 * registry has one on for this chat that the agent did not start with, this
 * offers a refresh: the existing "Restart agent session", which keeps the
 * conversation. Nothing restarts on its own and nothing polls: the chat's
 * machine answers when this chat opens, when a turn ends or a card closes
 * (an agent's own `mcp_registry.request` is one), and when the account's
 * settings change.
 */
export function McpRefreshChip({
  sessionId,
  runtimePin = null,
  turnActive,
  pendingInputItemId,
}: {
  sessionId: string;
  /** The chat's machine; null for the tab's own. */
  runtimePin?: OpenProjectBinding | null;
  turnActive: boolean;
  pendingInputItemId: string | null;
}) {
  const [missing, setMissing] = React.useState<string[]>([]);
  const [settingsTick, setSettingsTick] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const pinRef = React.useRef(runtimePin);
  pinRef.current = runtimePin;

  React.useEffect(() => {
    const onChanged = window.ade?.accountSettings?.onChanged;
    if (typeof onChanged !== "function") return undefined;
    return onChanged(() => setSettingsTick((tick) => tick + 1));
  }, []);

  React.useEffect(() => {
    const read = window.ade?.mcpRegistry?.chatStatus;
    if (typeof read !== "function") {
      setMissing([]);
      return undefined;
    }
    let active = true;
    void read({ chatSessionId: sessionId }, pinRef.current)
      .then((status) => { if (active) setMissing(Array.isArray(status?.missing) ? status.missing : []); })
      .catch(() => { if (active) setMissing([]); });
    return () => { active = false; };
    // A rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, runtimePin?.key, turnActive, pendingInputItemId, settingsTick]);

  if (!missing.length) return null;
  const names = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return (
    <StatusChip
      tone="accent"
      icon={<Plugs size={10} weight="bold" />}
      label={missing.length === 1 ? "New MCP server added" : "New MCP servers added"}
      actions={[{
        label: "Refresh chat",
        // A restart mid-turn would cut the agent off; it waits for the turn.
        disabled: busy || turnActive,
        testId: "chat-mcp-refresh",
        onClick: () => {
          if (busy || turnActive) return;
          setBusy(true);
          void restartAgentSession({ id: sessionId }, pinRef.current).finally(() => {
            setBusy(false);
            setSettingsTick((tick) => tick + 1);
          });
        },
      }]}
      help={`${names} ${missing.length === 1 ? "is" : "are"} not loaded in this chat yet. Refreshing restarts this chat's agent session so it loads the new MCP tools. The conversation is kept. Nothing restarts on its own${turnActive ? "; you can refresh when this turn ends" : ""}.`}
      testId="chat-mcp-refresh-chip"
    />
  );
}
