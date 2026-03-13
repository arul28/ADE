# Computer Use Artifact Broker

Last updated: 2026-03-12

## Purpose

The computer-use artifact broker is ADE's canonical boundary between external computer-use execution and ADE-managed proof workflows.

The broker exists so that ADE can stay external-first:

- external tools perform computer use
- ADE ingests and manages the resulting proof

## Boundary

ADE does not require all computer-use backends to share one fake runtime abstraction.

Instead:

- MCP-native backends such as Ghost OS remain MCP servers
- CLI-native backends such as agent-browser remain CLI workflows
- ADE discovers readiness, guides sessions toward the right backend, and ingests the resulting artifacts

The broker is the normalizing layer after execution has happened.

## Canonical Record Model

The broker stores canonical artifact records in `computer_use_artifacts` and ownership links in `computer_use_artifact_links`.

Each canonical artifact records:

- proof kind
- backend style and backend name
- source tool metadata
- title and description
- local or remote URI
- storage kind and MIME type
- review and workflow metadata
- created timestamp

Each link records:

- owner kind
- owner id
- relation
- per-link metadata

This lets one proof artifact move from exploratory chat evidence to formal workflow publication without losing provenance.

## Supported Proof Kinds

Canonical computer-use artifact kinds are:

- `screenshot`
- `video_recording`
- `browser_trace`
- `browser_verification`
- `console_logs`

The broker normalizes raw backend output into one of those kinds before storing it.

## Owner Model

Canonical ownership supports:

- lane
- mission
- orchestrator run
- orchestrator step
- orchestrator attempt
- chat session
- automation run
- GitHub PR
- Linear issue

This is the shared ownership model across Missions and normal Chat sessions.

## Runtime Responsibilities

The broker is responsible for:

- ingesting raw external output
- normalizing proof kinds
- storing canonical records
- linking owners
- updating review and workflow state
- surfacing canonical lists and snapshots to renderer surfaces
- projecting broker-managed artifacts into older mission and orchestrator artifact plumbing where compatibility still matters

The broker is not responsible for:

- clicking, typing, waiting, or navigating applications
- pretending CLI tools are MCP servers
- acting as a generic automation engine

## Readiness and Policy

The broker exposes backend readiness information used by:

- `Settings > Computer Use`
- mission preflight
- mission run monitoring
- chat session monitoring

That readiness model differentiates:

- approved external backends
- supported proof kinds per backend
- ADE local fallback availability

Policy is applied per scope through `ComputerUsePolicy`, which controls:

- mode: `off`, `auto`, `enabled`
- whether local fallback is allowed
- whether proof should be retained
- optional preferred backend

## User-Facing Surfaces

The broker-backed UX is intentionally cross-surface:

- `Settings > Computer Use`: readiness, setup guidance, fallback messaging
- mission launch and preflight: proof readiness and blocking state
- mission run view: live backend and proof monitoring
- mission artifact review: inspect, review, route, publish
- chat header/composer: session-level enablement and policy
- chat thread monitor: live activity and proof status
- chat artifact review: inspect, review, route, promote

## Publication Paths

Broker-managed artifacts can flow into:

- mission closeout
- lane history
- chat history
- GitHub PR workflows
- Linear closeout and issue workflows
- automation history

The broker keeps provenance intact so ADE can always answer:

- what artifact was produced
- which backend produced it
- who owns it now
- whether it has been reviewed
- whether it has been promoted or published

## Fallback-Only Rule

ADE-local computer use remains compatibility support only.

If an external backend can satisfy the proof kind, ADE should prefer the external backend.

If no approved external backend is available and local fallback is allowed for the current scope, the broker still records the resulting proof the same way so downstream review and publication stay consistent.
