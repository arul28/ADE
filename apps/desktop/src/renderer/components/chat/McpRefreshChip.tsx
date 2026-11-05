import React from "react";
import { Plugs } from "@phosphor-icons/react";

import type { OpenProjectBinding } from "../../../shared/types";
import { captureError } from "../../../shared/sentry/capture";
import { restartAgentSession } from "../terminals/sessionLifecycleActions";
import { StatusChip } from "../ui/notice/StatusChip";

/**
 * "New MCP server added · Refresh chat" (or removed, or changed), in the
 * composer's status row.
 *
 * A running chat keeps the MCP servers its agent started with. When the
 * registry has one on for this chat that the agent did not start with, or no
 * longer has one it did, this offers a refresh: the existing "Restart agent
 * session", which keeps the conversation. Nothing restarts on its own and nothing polls: the chat's
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
  const [status, setStatus] = React.useState<{ missing: string[]; removed: string[] }>(NO_CHANGES);
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
      setStatus(NO_CHANGES);
      return undefined;
    }
    let active = true;
    void read({ chatSessionId: sessionId }, pinRef.current)
      .then((next) => {
        if (!active) return;
        setStatus({
          missing: Array.isArray(next?.missing) ? next.missing : [],
          removed: Array.isArray(next?.removed) ? next.removed : [],
        });
      })
      .catch((error: unknown) => {
        // No chip is the safe fallback; report why the read failed.
        captureError(error, { fingerprint: ["mcp_refresh_chip", "chat_status_read"] });
        if (active) setStatus(NO_CHANGES);
      });
    return () => { active = false; };
    // A rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, runtimePin?.key, turnActive, pendingInputItemId, settingsTick]);

  const { missing, removed } = status;
  if (!missing.length && !removed.length) return null;
  const label = missing.length && removed.length ? "MCP servers changed"
    : missing.length ? (missing.length === 1 ? "New MCP server added" : "New MCP servers added")
      : removed.length === 1 ? "MCP server removed" : "MCP servers removed";
  const help = [
    missing.length ? `${nameList(missing)} ${missing.length === 1 ? "is" : "are"} not loaded in this chat yet.` : "",
    removed.length ? `${nameList(removed)} ${removed.length === 1 ? "is" : "are"} still loaded in this chat.` : "",
    "Refreshing restarts this chat's agent session so its MCP tools match your list. The conversation is kept. Nothing restarts on its own",
  ].filter(Boolean).join(" ");
  return (
    <StatusChip
      tone="accent"
      icon={<Plugs size={10} weight="bold" />}
      label={label}
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
      help={`${help}${turnActive ? "; you can refresh when this turn ends" : ""}.`}
      testId="chat-mcp-refresh-chip"
    />
  );
}

const NO_CHANGES = { missing: [], removed: [] };

function nameList(names: readonly string[]): string {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
