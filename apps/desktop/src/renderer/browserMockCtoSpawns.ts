/**
 * `?mockCtoSpawns=1`: the CTO thread (`mock-cto-session`) holds a turn that
 * started work the way the CTO does: two child chats (one on a fresh lane, one
 * on another provider), a read-only helper chat (`permissionMode "plan"`) and
 * a native background subagent. `?mockCtoSpawns=running` leaves them running.
 * The normal Work chat `mock-session-claude-1` gets the same turn, so the
 * regular subagent cards it still draws sit beside the CTO's quiet rows.
 */
const SESSION_IDS: ReadonlySet<string> = new Set(["mock-cto-session", "mock-session-claude-1"]);

export function browserMockCtoSpawnEvents(sessionId: string, mode: string | null): any[] {
  if (!mode || !SESSION_IDS.has(sessionId)) return [];
  const running = mode === "running";
  const base = Date.now() - 10 * 60_000;
  let tick = 0;
  const at = () => new Date(base + (tick += 1500)).toISOString();
  const out: any[] = [];
  const push = (event: Record<string, unknown>) => out.push({ sessionId, timestamp: at(), event });
  const turnId = "cto-spawn-turn-1";
  const tool = (id: string, name: string, args: Record<string, unknown>, result: Record<string, unknown>) => {
    const itemId = `${turnId}:${id}`;
    push({ type: "tool_call", tool: `mcp__ade__${name}`, args, itemId, logicalItemId: itemId, turnId });
    push({ type: "tool_result", tool: `mcp__ade__${name}`, result, itemId, logicalItemId: itemId, status: "completed", turnId });
  };
  const chatChild = (child: { id: string; title: string; provider: string; model: string; readOnly?: boolean }) => {
    push({
      type: "system_notice",
      noticeKind: "info",
      status: "subagent_spawned",
      message: `Subagent spawned: ${child.title}`,
      detail: { spawnedSession: { sessionId: child.id, laneId: "lane-main", title: child.title }, spawnKind: "subagent", hasInlineCard: true, ...(child.readOnly ? { readOnly: true } : {}) },
      turnId,
    });
    push({
      type: "subagent_started",
      taskId: `chat:${child.id}`,
      agentId: child.id,
      provider: child.provider,
      agentType: child.provider,
      parentToolUseId: null,
      description: child.title,
      background: false,
      taskType: "subagent",
      spawnKind: "subagent",
      model: child.model,
      ...(child.readOnly ? { readOnly: true } : {}),
      turnId,
    });
  };

  push({ type: "user_message", text: "Fix the flaky checkout test, move the receipt to the new API, and find out why deploys got slow.", turnId });
  push({ type: "status", turnStatus: "started", turnId });
  tool("t1", "spawnChat", { title: "Fix the flaky checkout test", modelId: "openai/gpt-6-luna" }, { success: true, sessionId: "mock-session-codex-1" });
  // An existing mock chat, so the row reads its live title and opens it; the
  // next child names no chat on this machine and keeps its spawn label.
  chatChild({ id: "mock-session-codex-1", title: "Fix the flaky checkout test", provider: "codex", model: "gpt-6-luna" });
  tool("t2", "spawnChat", { title: "Move the receipt to the new API", modelId: "anthropic/claude-sonnet-5-5" }, { success: true, sessionId: "mock-cto-child-2" });
  chatChild({ id: "mock-cto-child-2", title: "Move the receipt to the new API", provider: "claude", model: "claude-sonnet-5-5" });
  tool("t3", "spawnChat", { title: "Read the deploy logs", modelId: "openai/gpt-6-luna", permissionMode: "plan" }, { success: true, sessionId: "mock-cto-helper-1" });
  chatChild({ id: "mock-cto-helper-1", title: "Read the deploy logs", provider: "codex", model: "gpt-6-luna", readOnly: true });
  const nativeItem = `${turnId}:t4`;
  push({ type: "tool_call", tool: "Agent", args: { description: "Profile the deploy pipeline", subagent_type: "Explore", run_in_background: true }, itemId: nativeItem, logicalItemId: nativeItem, turnId });
  push({ type: "subagent_started", taskId: "native-task-1", agentId: "native-agent-1", agentType: "Explore", parentToolUseId: nativeItem, description: "Profile the deploy pipeline", background: true, taskType: "subagent", turnId });
  push({ type: "tool_result", tool: "Agent", result: "Async agent launched.", itemId: nativeItem, logicalItemId: nativeItem, status: "completed", turnId });
  tool("t5", "spawnChat", { title: "Check the Android build", modelId: "openai/gpt-6-luna", machine: "Mac Studio" }, {
    success: true, machineId: "mock-studio", machineName: "Mac Studio", sessionId: "mock-remote-child-1", laneId: "lane-android", requestedTitle: "Check the Android build", provider: "codex",
  });
  tool("t6", "spawnChat", { title: "Draft the release notes", modelId: "anthropic/claude-sonnet-5-5", machine: "cloud" }, {
    success: true, adeCloud: true, launchId: "mock-cloud-launch-1", phase: "starting", laneName: "release-notes", sessionId: "mock-cloud-launch-1", machine: { name: null },
  });
  tool("t7", "spawnChat", { title: "Bump the SDK", modelId: "openai/gpt-6-luna" }, { success: false, error: "No lane named sdk-bump on this machine." });
  push({ type: "text", text: "On it. I'll tell you when they're done.", messageId: `${turnId}:m1`, turnId });
  push({ type: "status", turnStatus: "completed", turnId });
  push({ type: "done", turnId, status: "completed", model: "claude-opus-5-5", modelId: "anthropic/claude-opus-5-5" });
  if (!running) {
    push({ type: "subagent_result", taskId: "native-task-1", agentId: "native-agent-1", agentType: "Explore", parentToolUseId: nativeItem, status: "completed", summary: "Deploys wait 4 minutes on a cold Docker layer cache." });
    push({ type: "subagent_result", taskId: "chat:mock-cto-helper-1", agentId: "mock-cto-helper-1", provider: "codex", agentType: "codex", parentToolUseId: null, status: "completed", summary: "The slow step is the image build." });
  }
  return out;
}
