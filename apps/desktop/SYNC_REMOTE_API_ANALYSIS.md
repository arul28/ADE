# Sync Remote API Analysis for Mobile Chat Client

## 1. All Existing Remote Commands

The desktop exposes remote commands via `syncRemoteCommandService.ts`. Each command is routed through a WebSocket-based sync protocol. Commands are registered with a policy (`{ viewerAllowed, queueable? }`). Chat event streaming uses separate sync envelopes (`chat_subscribe`, `chat_unsubscribe`, `chat_event`) and is gated by `hello_ok.features.chatStreaming.enabled`.

### Chat Commands (13 total)
| Command | Parameters | Response | Policy |
|---------|-----------|----------|--------|
| `chat.listSessions` | `{ laneId?: string, includeAutomation?: boolean }` | `AgentChatSessionSummary[]` | viewerAllowed |
| `chat.getSummary` | `{ sessionId: string }` | `AgentChatSessionSummary \| null` | viewerAllowed |
| `chat.getTranscript` | `{ sessionId: string, limit?: number, maxChars?: number }` | Transcript entries | viewerAllowed |
| `chat.create` | `{ laneId: string, provider?: string, model?: string, modelId?: string, reasoningEffort?: string }` | `AgentChatSession` | viewerAllowed, queueable |
| `chat.send` | `{ sessionId: string, text: string }` | `{ ok: true }` | viewerAllowed, queueable |
| `chat.interrupt` | `{ sessionId: string }` | `{ ok: true }` | viewerAllowed |
| `chat.steer` | `{ sessionId: string, text: string }` | `{ ok: true }` | viewerAllowed |
| `chat.approve` | `{ sessionId: string, itemId: string, decision: string, responseText?: string }` | `{ ok: true }` | viewerAllowed |
| `chat.respondToInput` | `{ sessionId: string, itemId: string, decision?: string, answers?: object, responseText?: string }` | `{ ok: true }` | viewerAllowed |
| `chat.resume` | `{ sessionId: string }` | `AgentChatSession` | viewerAllowed, queueable |
| `chat.updateSession` | `{ sessionId: string, title?, modelId?, reasoningEffort?, permissionMode?, ... }` | `AgentChatSession` | viewerAllowed, queueable |
| `chat.dispose` | `{ sessionId: string }` | `{ ok: true }` | viewerAllowed, queueable |
| `chat.models` | `{ provider?: string }` | `AgentChatModelInfo[]` | viewerAllowed |

### Lane Commands (29 total)
| Command | Policy |
|---------|--------|
| `lanes.list` | viewerAllowed |
| `lanes.refreshSnapshots` | viewerAllowed |
| `lanes.getDetail` | viewerAllowed |
| `lanes.create` | viewerAllowed, queueable |
| `lanes.createChild` | viewerAllowed, queueable |
| `lanes.createFromUnstaged` | viewerAllowed, queueable |
| `lanes.attach` | viewerAllowed, queueable |
| `lanes.adoptAttached` | viewerAllowed, queueable |
| `lanes.rename` | viewerAllowed, queueable |
| `lanes.reparent` | viewerAllowed, queueable |
| `lanes.updateAppearance` | viewerAllowed, queueable |
| `lanes.archive` | viewerAllowed, queueable |
| `lanes.unarchive` | viewerAllowed, queueable |
| `lanes.delete` | viewerAllowed, queueable |
| `lanes.getStackChain` | viewerAllowed |
| `lanes.getChildren` | viewerAllowed |
| `lanes.rebaseStart` | viewerAllowed, queueable |
| `lanes.rebasePush` | viewerAllowed, queueable |
| `lanes.rebaseRollback` | viewerAllowed, queueable |
| `lanes.rebaseAbort` | viewerAllowed, queueable |
| `lanes.listRebaseSuggestions` | viewerAllowed |
| `lanes.dismissRebaseSuggestion` | viewerAllowed, queueable |
| `lanes.deferRebaseSuggestion` | viewerAllowed, queueable |
| `lanes.listAutoRebaseStatuses` | viewerAllowed |
| `lanes.listTemplates` | viewerAllowed |
| `lanes.getDefaultTemplate` | viewerAllowed |
| `lanes.initEnv` | viewerAllowed, queueable |
| `lanes.getEnvStatus` | viewerAllowed |
| `lanes.applyTemplate` | viewerAllowed, queueable |

### Work/Session Commands (3 total)
| Command | Parameters | Policy |
|---------|-----------|--------|
| `work.listSessions` | `{ laneId?: string, status?: string, limit?: number }` | viewerAllowed |
| `work.runQuickCommand` | `{ laneId, title, startupCommand?, cols?, rows?, toolType?, tracked? }` | viewerAllowed, queueable |
| `work.closeSession` | `{ sessionId: string }` | viewerAllowed, queueable |

### Git Commands (30 total)
`git.getChanges`, `git.getFile`, `git.stageFile`, `git.stageAll`, `git.unstageFile`, `git.unstageAll`, `git.discardFile`, `git.restoreStagedFile`, `git.commit`, `git.generateCommitMessage`, `git.listRecentCommits`, `git.listCommitFiles`, `git.getCommitMessage`, `git.revertCommit`, `git.cherryPickCommit`, `git.stashPush`, `git.stashList`, `git.stashApply`, `git.stashPop`, `git.stashDrop`, `git.fetch`, `git.pull`, `git.getSyncStatus`, `git.sync`, `git.push`, `git.getConflictState`, `git.rebaseContinue`, `git.rebaseAbort`, `git.listBranches`, `git.checkoutBranch`

### File Commands (1)
| `files.writeTextAtomic` | `{ laneId, path, text }` | viewerAllowed, queueable |

### Conflict Commands (3)
`conflicts.getLaneStatus`, `conflicts.listOverlaps`, `conflicts.getBatchAssessment`

### PR Commands (13)
`prs.list`, `prs.refresh`, `prs.getDetail`, `prs.getStatus`, `prs.getChecks`, `prs.getReviews`, `prs.getComments`, `prs.getFiles`, `prs.createFromLane`, `prs.land`, `prs.close`, `prs.reopen`, `prs.requestReviewers`

**Total: 92 registered remote commands**

---

## 2. Streaming/Event Push Mechanism

### Current State: chat event streaming is available to sync peers

The desktop has two separate event delivery systems:

1. **IPC Events (Electron renderer only)**: Chat events flow via `onEvent` callback → `emitProjectEvent(projectRoot, IPC.agentChatEvent, event)` which sends `AgentChatEventEnvelope` objects to the Electron renderer process.

2. **Sync WebSocket (mobile/external peers)**: The sync host subscribes to `agentChatService` events and broadcasts matching `chat_event` envelopes to peers that sent `chat_subscribe { sessionId }`. `chat_unsubscribe { sessionId }` stops delivery. There is no `chat_snapshot` envelope in the current implementation.

### How Sync Streaming Works
- Peer sends `chat_subscribe { sessionId }`
- Desktop starts pushing `chat_event` envelopes for that session to the subscribed peer
- Peer sends `chat_unsubscribe { sessionId }` to stop

### How Terminal Streaming Works
- Peer sends `terminal_subscribe { sessionId, maxBytes? }` → receives `terminal_snapshot` with current transcript
- Desktop pushes `terminal_data` events as PTY data arrives
- Desktop pushes `terminal_exit` when PTY exits
- Peer sends `terminal_unsubscribe { sessionId }` to stop

### Other Push Events
- `heartbeat` (ping/pong, every 30s)
- `changeset_batch` (cr-sqlite CRDT changes, polled every 400ms)
- `brain_status` (host metrics, every 5s)

---

## 3. MISSING Commands for Full Mobile Chat Client

The following `agentChatService` public methods have **NO remote command equivalent** in `syncRemoteCommandService`:

| Missing Command | agentChatService Method | Priority | Description |
|----------------|------------------------|----------|-------------|
| `chat.handoff` | `handoffSession({ sourceSessionId, targetModelId })` | Medium | Switch model mid-session |
| `chat.getCapabilities` | `getSessionCapabilities({ sessionId })` | Medium | Get session capabilities |
| `chat.listSubagents` | `listSubagents({ sessionId })` | Medium | List active subagents |
| `chat.slashCommands` | `getSlashCommands({ sessionId })` | Low | Get available slash commands |
| `chat.fileSearch` | `codexFuzzyFileSearch({ sessionId, query })` | Low | Search for files to attach |
| `chat.warmupModel` | `warmupModel({ sessionId, modelId })` | Low | Pre-warm a model before use |

---

## 4. Session State Machine

### Session Status (`AgentChatSessionStatus`)
```
"active" | "idle" | "ended"
```

### Turn Status (within `AgentChatEvent.status`)
```
"started" → "completed" | "interrupted" | "failed"
```

### Session Lifecycle
```
create → idle
idle + send/steer → active (turn started)
active + turn completes → idle
active + interrupt → idle (turn interrupted)
idle + dispose → ended
ended + resume → idle
```

### Runtime States
Each session has a `ChatRuntime` which can be:
- `CodexRuntime` (OpenAI Codex process)
- `ClaudeRuntime` (Anthropic Claude CLI SDK)
- `UnifiedRuntime` (Vercel AI SDK, direct API)

Runtime-specific states:
- **busy**: a turn is currently executing
- **interrupted**: interrupt was requested
- **pendingSteers**: queue of messages to send after current turn completes (max 10)
- **pendingApprovals**: tool-use approval requests waiting for user input

---

## 5. Message/Event Type Definitions

### `AgentChatEvent` (27 event types)
| Type | Key Fields | Description |
|------|-----------|-------------|
| `user_message` | text, attachments?, turnId? | User sent a message |
| `text` | text, messageId?, turnId? | Assistant text delta (streaming) |
| `tool_call` | tool, args, itemId, turnId? | Tool invocation started |
| `tool_result` | tool, result, itemId, status? | Tool completed/failed |
| `file_change` | path, diff, kind, itemId, status? | File was created/modified/deleted |
| `command` | command, cwd, output, itemId, status | Shell command execution |
| `plan` | steps[], explanation? | Plan outline |
| `reasoning` | text, turnId?, summaryIndex? | Model reasoning/thinking |
| `approval_request` | itemId, kind, description | Tool use needs approval |
| `status` | turnStatus, turnId?, message? | Turn lifecycle event |
| `delegation_state` | contract, message? | Delegation/handoff state |
| `error` | message, errorInfo? | Error occurred |
| `done` | turnId, status, model?, usage? | Turn completed/interrupted/failed |
| `activity` | activity, detail? | Current activity indicator |
| `step_boundary` | stepNumber | Step separator |
| `todo_update` | items[] | Todo list changes |
| `subagent_started` | taskId, description | Subagent spawned |
| `subagent_progress` | taskId, summary, usage? | Subagent progress |
| `subagent_result` | taskId, status, summary | Subagent completed |
| `structured_question` | question, options?, itemId | Question for the user |
| `tool_use_summary` | summary, toolUseIds | Summarized tool uses |
| `context_compact` | trigger | Context was compacted |
| `system_notice` | noticeKind, message, detail? | System notification |
| `completion_report` | report | Session completion summary |
| `web_search` | query, itemId, status | Web search event |
| `auto_approval_review` | targetItemId, reviewStatus | Auto-approval decision |
| `prompt_suggestion` | suggestion | Suggested follow-up prompt |
| `plan_text` | text | Plan text content |

### `AgentChatEventEnvelope`
```typescript
{
  sessionId: string;
  timestamp: string;
  event: AgentChatEvent;
  sequence?: number;
  provenance?: {
    messageId?: string;
    threadId?: string | null;
    role?: "user" | "orchestrator" | "worker" | "agent" | null;
    // ... more fields
  };
}
```

### `PendingInputRequest` (approval/question data)
```typescript
{
  requestId: string;
  itemId?: string;
  source: "claude" | "codex" | "unified" | "mission" | "ade";
  kind: "approval" | "question" | "structured_question" | "permissions" | "plan_approval";
  title?: string | null;
  description?: string | null;
  questions: PendingInputQuestion[];
  allowsFreeform: boolean;
  blocking: boolean;
  canProceedWithoutAnswer: boolean;
  options?: PendingInputOption[];
  turnId?: string | null;
}
```

---

## 6. WebSocket Protocol Details

### Connection Flow
1. Client opens WebSocket to `ws://<host>:8787`
2. Client sends `hello` or `pairing_request` envelope
3. Desktop validates auth (bootstrap token or paired device credentials)
4. Desktop sends `hello_ok` with features list (including `chatStreaming` and all supported command actions)
5. Authenticated peer can send commands, subscribe to terminals, and, when `chatStreaming.enabled` is true, subscribe to chat events.

### Envelope Format
```typescript
{
  version: 1,                          // Protocol version
  type: string,                        // Message type
  requestId?: string | null,           // For request/response correlation
  compression: "none" | "gzip",       // Payload compression
  payloadEncoding: "json" | "base64", // Encoding
  payload: unknown,                    // The actual data
  uncompressedBytes?: number,          // Original size if compressed
}
```

### Authentication
Two auth methods:
1. **Bootstrap token**: Shared secret stored at `.ade/secrets/sync-bootstrap-token`
2. **Paired device**: Device-specific credentials via QR code pairing flow

### Command Protocol
```
Client → command { commandId, action, args }
Desktop → command_ack { commandId, accepted, status, message }
Desktop → command_result { commandId, ok, result?, error? }
```

---

## 7. Connection Management

- **No rate limiting** on commands or connections
- **No max peer limit** — peers are tracked in a `Set<PeerState>`
- **Heartbeat**: 30s interval, unanswered heartbeat → close with code 4001
- **mDNS**: Host published via Bonjour (`ade-sync` service type)
- **Max WebSocket payload**: 25 MB
- **Compression threshold**: 4 KB (payloads ≥4KB are gzip compressed)

---

## 8. Recommendations for Backend Changes

### Critical (required for basic mobile chat)

1. **Chat streaming is already wired through sync envelopes**: `chat_subscribe` and `chat_unsubscribe` gate `chat_event` pushes, and the capability should be checked via `hello_ok.features.chatStreaming.enabled` before subscribing.

2. **Remaining chat commands for mobile**:
   - `chat.handoff` → `agentChatService.handoffSession()`
   - `chat.getCapabilities` → `agentChatService.getSessionCapabilities()`
   - `chat.listSubagents` → `agentChatService.listSubagents()`
   - `chat.slashCommands` → `agentChatService.getSlashCommands()`
   - `chat.fileSearch` → `agentChatService.codexFuzzyFileSearch()`
   - `chat.warmupModel` → `agentChatService.warmupModel()`

### High Priority

3. **Consider whether mobile needs the remaining read-only commands immediately**: `chat.getCapabilities`, `chat.listSubagents`, and `chat.slashCommands` are the most likely next additions.

### Nice to Have

4. **Consider connection-level rate limiting**: Currently there's no protection against command flooding from peers.

### What Mobile Can Do with Existing APIs

With the 13 existing chat commands, mobile can already:
- ✅ List chat sessions per lane
- ✅ Get session summaries
- ✅ Read chat transcripts (polling)
- ✅ Create new chat sessions
- ✅ Send initial messages
- ✅ Interrupt, steer, approve, and answer input requests in real time
- ✅ Resume, update, and dispose chat sessions
- ✅ List available models
- ✅ Receive real-time chat events after `chat_subscribe`
- ❌ Cannot hand off sessions to a different model
- ❌ Cannot query capabilities, subagents, slash commands, file search, or model warmup

### Implementation Approach

The most impactful single change is adding **chat event streaming** via `chat_subscribe`/`chat_event` envelopes and gating it behind `hello_ok.features.chatStreaming.enabled`. The additional command registrations are straightforward - they just wire existing service methods through the existing command dispatch pattern.
