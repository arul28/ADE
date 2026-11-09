import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useNavigate } from "react-router-dom";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { useLatestCallback } from "../../lib/stableIdentity";
import { useWorkspacePathOpener, type ChatWorkspacePathOpener } from "../chat/chatWorkspacePaths";
import type { TerminalPathLinkContext } from "./terminalPathLinks";

export type TerminalPathLinkHandle = {
  openWorkspacePath: ChatWorkspacePathOpener;
  ensureLaneId: () => Promise<string | null>;
};

/**
 * Connects a terminal's link provider to the same opener a chat path uses. The
 * runtime outlives this component, so the provider reads the opener through its
 * context object. The lane is asked for on the first hover, not on mount.
 */
export function TerminalPathLinkBridge({
  handleRef,
  runtimeRef,
  sessionId,
  runtimePin,
}: {
  handleRef: MutableRefObject<TerminalPathLinkHandle | null>;
  runtimeRef: MutableRefObject<{ pathLinks: TerminalPathLinkContext } | null>;
  sessionId: string;
  runtimePin: OpenProjectBinding | null;
}) {
  const navigate = useNavigate();
  const [laneId, setLaneId] = useState<string | null>(null);
  const laneReadRef = useRef<{ key: string; read: Promise<string | null> } | null>(null);
  const scopeKey = `${runtimePin?.key ?? ""}\0${sessionId}`;

  useEffect(() => {
    setLaneId(null);
    laneReadRef.current = null;
  }, [scopeKey]);

  const ensureLaneId = useLatestCallback(async (): Promise<string | null> => {
    const held = laneReadRef.current;
    if (held?.key === scopeKey) return held.read;
    const read = (async () => {
      try {
        const detail = runtimePin
          ? await window.ade.sessions.get(sessionId, runtimePin)
          : await window.ade.sessions.get(sessionId);
        return detail?.laneId ?? null;
      } catch (error) {
        logRendererDebugEvent("terminal.path_link_lane_read_failed", { error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    })();
    laneReadRef.current = { key: scopeKey, read };
    const resolved = await read;
    // A failed read is not remembered, so the next hover can try again.
    if (resolved === null && laneReadRef.current?.key === scopeKey) laneReadRef.current = null;
    setLaneId(resolved);
    return resolved;
  });

  const { openWorkspacePath } = useWorkspacePathOpener({ laneId, navigate, runtimePin });
  handleRef.current = { openWorkspacePath, ensureLaneId };

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.pathLinks.openWorkspacePath = openWorkspacePath;
    runtime.pathLinks.ensureLaneId = ensureLaneId;
  }, [ensureLaneId, openWorkspacePath, runtimeRef]);

  return null;
}
