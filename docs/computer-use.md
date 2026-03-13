# Computer Use in ADE

Last updated: 2026-03-12

## Core Model

ADE is not the primary low-level computer-use executor.

ADE is the control plane for computer-use proof:

- external tools perform the actual browser or desktop automation
- ADE discovers those backends, shows their readiness, and injects the right guidance into ADE-managed sessions
- ADE ingests screenshots, videos, traces, verification output, and logs from those backends
- ADE normalizes everything into canonical proof artifacts
- ADE links those artifacts to missions, chats, lanes, runs, PRs, Linear issues, and closeout flows
- ADE helps operators monitor what happened, review the proof, and decide what to do next

This boundary is intentionally the same in both Missions and normal Chat sessions.

## Supported Backends

| Backend | Transport | ADE role |
| --- | --- | --- |
| Ghost OS | External MCP server | ADE connects through External MCP, discovers tools, and uses Ghost OS as an approved external macOS computer-use backend. |
| agent-browser | External CLI/daemon workflow | ADE detects local availability, expects agent-browser to run externally, and ingests its output artifacts and manifests. agent-browser is not an MCP server. |
| ADE local computer use | Local compatibility runtime | Fallback-only support for environments where approved external backends are unavailable for a required proof kind. |

ADE currently normalizes these proof kinds:

- `screenshot`
- `video_recording`
- `browser_trace`
- `browser_verification`
- `console_logs`

## Settings and Readiness

Use `Settings > Computer Use` as the main readiness surface.

That screen shows:

- ADE's external-first role and fallback-only messaging
- Ghost OS readiness and a jump into `Settings > Integrations > External MCP`
- agent-browser installation/availability status
- ADE local fallback availability
- a capability matrix showing which backend can satisfy each proof kind
- the current preferred backend, when one is known

### Ghost OS setup

1. Install Ghost OS on the host machine.
2. Open `Settings > Integrations > External MCP`.
3. Add or enable the Ghost OS server there.
4. Return to `Settings > Computer Use` and confirm it shows as connected and capable for the proof kinds you need.

Ghost OS is the primary external macOS accessibility/computer-use path in ADE.

### agent-browser setup

1. Install the `agent-browser` CLI on the host machine.
2. Open `Settings > Computer Use`.
3. Confirm ADE detects the CLI as available.
4. Run agent-browser externally when you want browser automation proof, then ingest the produced artifacts or manifests into ADE.

agent-browser remains CLI-native. ADE does not pretend it is an MCP server.

### Fallback policy

Computer-use policy is controlled per scope:

- mode: `off`, `auto`, or `enabled`
- whether ADE local fallback is allowed
- whether proof artifacts should be retained
- optional preferred backend selection

ADE local computer use should only be used when:

- the operator explicitly allows fallback for that scope, and
- the required proof kind is not currently satisfied by an approved external backend

## Mission Flow

### 1. Launch and Preflight

Mission launch and preflight now surface computer-use readiness directly:

- required proof kinds for the selected phase profile
- the mission's computer-use policy
- approved external backends currently available
- whether ADE can satisfy the proof contract externally
- whether proof is only available through local fallback
- whether the mission is blocked because proof is required but not satisfiable

If proof is required and the mission is not ready, preflight calls that out explicitly instead of assuming ADE-local runtime is the answer.

### 2. Mission Run Monitoring

Mission run detail includes a dedicated `Computer Use` operational section that shows:

- the active or inferred backend
- whether the mission is external-first or currently using fallback
- recent computer-use activity
- recent retained proof artifacts
- the current proof coverage summary

This is the live operator view for "what backend is being used and what proof is arriving right now."

### 3. Mission Artifact Review and Closeout

Mission artifact review now includes a dedicated computer-use proof panel for:

- inspecting normalized screenshots, traces, logs, videos, and verification outputs
- seeing backend provenance and linked owners
- reviewing proof as `accepted`, `needs_more`, `dismissed`, or `published`
- routing artifacts to related owners such as lane, GitHub PR, Linear issue, or automation run

Mission closeout can use broker-managed computer-use artifacts regardless of whether they came from Ghost OS, agent-browser, or fallback capture.

## Chat Flow

Computer use is also a first-class part of normal ADE chat sessions.

### 1. Chat Enablement

The chat header and composer expose the session policy directly:

- `CU Off`
- `CU Auto`
- `CU On`
- `Fallback`
- `Proof`

That lets the user decide whether the chat may use computer use, whether local fallback is allowed, and whether retained proof should be kept for review.

### 2. Chat Monitoring

When a chat session is selected, the thread shows a dedicated computer-use monitor with:

- current proof summary
- active backend
- whether the chat is in external-first or fallback mode
- recent computer-use activity
- recent retained artifacts

This keeps exploratory chat sessions visible instead of making computer use feel like hidden ADE-internal behavior.

### 3. Chat Artifact Review

Chat sessions that use computer use now have a first-class artifact review surface for:

- screenshots
- traces
- logs
- verification results
- backend provenance
- timestamps and ownership links
- review actions such as accept, dismiss, request more proof, or publish

### 4. Promotion and Routing

Chat output is often exploratory, so ADE supports promoting artifacts out of chat into formal workflow objects.

From chat artifact review, operators can:

- keep the artifact attached to the chat session
- attach it to a mission
- attach it to a lane
- attach it to a GitHub PR
- attach it to a Linear issue
- leave it as evidence-only
- dismiss it

## Artifact Ownership and Routing

Computer-use artifacts use a canonical owner-link model. A single artifact can be linked to more than one owner over time.

User-visible owners can include:

- lane
- mission
- orchestrator run
- orchestrator step
- orchestrator attempt
- chat session
- automation run
- GitHub PR
- Linear issue

The artifact review surfaces show those links so the operator can understand where the proof belongs and whether it still needs promotion.

## What External Tools Own vs What ADE Owns

External tools own:

- browser and desktop interaction
- low-level click, type, focus, wait, and navigation behavior
- native runtime details specific to their transport or platform

ADE owns:

- backend discovery and readiness status
- policy and fallback messaging
- session and mission guidance
- artifact ingestion and normalization
- canonical storage and ownership links
- monitoring surfaces
- review state and routing actions
- publication into mission closeout, lane history, chat history, PR workflows, Linear workflows, and automation history

## What Remains Fallback-Only

ADE's native local computer-use capabilities remain compatibility support only.

That includes the legacy local screenshot and GUI interaction layer used to satisfy proof only when:

- the scope allows local fallback, and
- no approved external backend is available for the required proof kind

ADE does not expand that local runtime into a bigger in-house browser or desktop automation engine.

## Related Docs

- `docs/architecture/COMPUTER_USE_ARTIFACT_BROKER.md`
- `docs/final-plan/phase-4/W8.md`
- `docs/PRD.md`
