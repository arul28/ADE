import { useMemo } from "react";
import { Panel, Group } from "react-resizable-panels";
import { X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { ResizeGutter } from "../ui/ResizeGutter";
import { TerminalView } from "../terminals/TerminalView";
import type { TerminalSessionSummary } from "../../../shared/types";

type TileNode =
  | { type: "leaf"; id: string; sessionId: string; leafCount: number }
  | { type: "split"; id: string; direction: "horizontal" | "vertical"; children: [TileNode, TileNode]; leafCount: number };

function buildTree(items: TerminalSessionSummary[], depth = 0): TileNode {
  if (items.length === 1) {
    return {
      type: "leaf",
      id: items[0].id,
      sessionId: items[0].id,
      leafCount: 1
    };
  }
  const direction = depth % 2 === 0 ? "horizontal" : "vertical";
  const mid = Math.ceil(items.length / 2);
  const first = buildTree(items.slice(0, mid), depth + 1);
  const second = buildTree(items.slice(mid), depth + 1);
  return {
    type: "split",
    id: `${direction}:${first.id}|${second.id}`,
    direction,
    children: [first, second],
    leafCount: first.leafCount + second.leafCount
  };
}

function proportionalSize(node: TileNode, total: number): number {
  if (total <= 0) return 50;
  return (node.leafCount / total) * 100;
}

export function TilingLayout({
  sessions,
  focusedSessionId,
  onFocus,
  onClose,
  closingSessionIds
}: {
  sessions: TerminalSessionSummary[];
  focusedSessionId: string | null;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  closingSessionIds?: Set<string>;
}) {
  const layout = useMemo(() => {
    if (sessions.length === 0) return null;
    return buildTree(sessions);
  }, [sessions]);

  if (!layout) return <div className="p-4 text-muted-fg text-xs text-center">No terminals.</div>;

  return (
    <div className="h-full w-full">
      <TileRenderer
        node={layout}
        sessions={sessions}
        focusedSessionId={focusedSessionId}
        onFocus={onFocus}
        onClose={onClose}
        closingSessionIds={closingSessionIds ?? new Set()}
      />
    </div>
  );
}

function TileRenderer({
  node,
  sessions,
  focusedSessionId,
  onFocus,
  onClose,
  closingSessionIds
}: {
  node: TileNode;
  sessions: TerminalSessionSummary[];
  focusedSessionId: string | null;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  closingSessionIds: Set<string>;
}) {
  if (node.type === "leaf") {
    const session = sessions.find((s) => s.id === node.sessionId);
    if (!session) return null;

    const isRunning = session.status === "running" && !!session.ptyId;
    const isActive = session.id === focusedSessionId;
    const isClosing = closingSessionIds.has(session.id);

    return (
      <div
        className={cn(
          "group relative flex h-full w-full flex-col overflow-hidden border transition-colors",
          isActive ? "border-accent ring-1 ring-accent" : "border-border"
        )}
        onClick={() => onFocus(session.id)}
      >
        <div
          className={cn(
            "absolute inset-x-0 top-0 z-10 flex items-center justify-between px-2 py-1 transition-opacity",
            isRunning ? "bg-black/40 text-white opacity-0 backdrop-blur-sm group-hover:opacity-100" : "bg-muted/20 text-muted-fg opacity-100"
          )}
        >
          <span className="max-w-[80%] truncate font-mono text-[11px]">{session.title}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0 text-current hover:text-red-400"
            disabled={isClosing}
            onClick={(e) => {
              e.stopPropagation();
              onClose(session.id);
            }}
            title={isClosing ? "Closing terminal" : "Close terminal"}
          >
            <X size={12} />
          </Button>
        </div>

        <div className="min-h-0 flex-1 bg-bg">
          {isRunning ? (
            <TerminalView ptyId={session.ptyId!} sessionId={session.id} className="h-full" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-4 text-center text-muted-fg">
              <div className="text-xs font-semibold">{session.title}</div>
              <div className="mt-1 text-[11px] uppercase">{session.status}</div>
              <div className="mt-2 text-[11px] opacity-50">Exit code: {session.exitCode ?? "?"}</div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const [first, second] = node.children;
  const firstSize = proportionalSize(first, node.leafCount);
  const secondSize = 100 - firstSize;

  return (
    <Group id={`tiling-group:${node.id}`} orientation={node.direction} className="h-full w-full">
      <Panel id={`tiling-panel:${first.id}`} defaultSize={`${firstSize}%`} minSize="10%">
        <TileRenderer
          node={first}
          sessions={sessions}
          focusedSessionId={focusedSessionId}
          onFocus={onFocus}
          onClose={onClose}
          closingSessionIds={closingSessionIds}
        />
      </Panel>
      <ResizeGutter orientation={node.direction === "horizontal" ? "vertical" : "horizontal"} />
      <Panel id={`tiling-panel:${second.id}`} defaultSize={`${secondSize}%`} minSize="10%">
        <TileRenderer
          node={second}
          sessions={sessions}
          focusedSessionId={focusedSessionId}
          onFocus={onFocus}
          onClose={onClose}
          closingSessionIds={closingSessionIds}
        />
      </Panel>
    </Group>
  );
}
