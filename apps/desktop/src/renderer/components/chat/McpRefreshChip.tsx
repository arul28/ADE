import React from "react";
import { Plugs } from "@phosphor-icons/react";

import type { OpenProjectBinding } from "../../../shared/types";
import { captureError } from "../../../shared/sentry/capture";
import { restartAgentSession } from "../terminals/sessionLifecycleActions";
import { StatusChip } from "../ui/notice/StatusChip";
import { withChatPin } from "./chatMachinePin";

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
  const [status, setStatus] = React.useState<ChatMcpChanges>(NO_CHANGES);
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
    void withChatPin(pinRef.current, (chatPin) => read({ chatSessionId: sessionId }, chatPin))
      .then((next) => {
        if (!active) return;
        const missing = Array.isArray(next?.missing) ? next.missing : [];
        const changed = Array.isArray(next?.changed) ? next.changed : [];
        setStatus({
          added: missing.filter((name) => !changed.includes(name)),
          changed,
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

  const { added, changed, removed } = status;
  if (!added.length && !changed.length && !removed.length) return null;
  const help = [
    added.length ? `New: ${nameList(added)}.` : "",
    changed.length ? `Changed: ${nameList(changed)}.` : "",
    removed.length ? `Removed or turned off: ${nameList(removed)}.` : "",
    "This chat still runs the MCP servers it started with. Refreshing restarts its agent session so they match your list. The conversation is kept. Nothing restarts on its own",
  ].filter(Boolean).join(" ");
  return (
    <StatusChip
      tone="accent"
      icon={<Plugs size={10} weight="bold" />}
      label={chipLabel(status)}
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

/** How this chat's MCP servers differ from the list: new, edited, and removed or turned off. */
type ChatMcpChanges = { added: string[]; changed: string[]; removed: string[] };

const NO_CHANGES: ChatMcpChanges = { added: [], changed: [], removed: [] };

/** "Added" only when that is all it is; an edit or a server turned off is a change. */
function chipLabel({ added, changed, removed }: ChatMcpChanges): string {
  const count = added.length + changed.length + removed.length;
  if (added.length === count) return count === 1 ? "New MCP server added" : "New MCP servers added";
  return count === 1 ? "MCP server changed" : "MCP servers changed";
}

function nameList(names: readonly string[]): string {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
