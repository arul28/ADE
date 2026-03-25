# ADE product requirements document

> Architecture, service layout, and storage contracts live under [`docs/architecture/`](./architecture/SYSTEM_OVERVIEW.md). This document owns product behavior, operator workflows, and scope.
>
> Last updated: 2026-03-25

## What ADE is

ADE (Agentic Development Environment) is a local-first desktop workspace for orchestrating coding agents across parallel lanes, missions, pull requests, and proof capture flows. It is a control plane for software delivery work that already happens in repositories, branches, terminals, and AI runtimes.

ADE is not a hosted agent platform and it is not an IDE replacement. It sits beside the repo and gives operators one place to launch, supervise, coordinate, and audit AI-assisted development work.

## Problem statement

Teams using multiple AI coding agents run into the same operational failures repeatedly:

- context gets scattered across terminals, branches, and PRs
- parallel work collides late, usually during merge or review
- humans have to reconstruct what each agent changed before they can trust it
- tool access and proof collection vary by workflow, making runs hard to compare
- there is no stable control surface for orchestrating work across different AI providers

ADE exists to make that workflow explicit, observable, and recoverable.

## Product goals

- Keep agent-driven work local-first and repo-native.
- Make parallel work visible through lanes, missions, PR views, and conflict tooling.
- Give operators durable context without dumping raw transcripts into every run.
- Preserve explicit human control around risky transitions such as merge, escalation, and computer use.
- Stay provider-flexible across CLI subscriptions, API-backed models, and local endpoints.

## Product principles

- Local-first by default: project state lives under `.ade/` inside the repo, with machine-local secrets and cache stored separately.
- Operational over promotional: surfaces should say what changed, what is blocked, and what the next action is.
- Shared contracts over renderer workarounds: changes that affect state or workflows should be enforced in services and shared types.
- Explicit trust boundaries: the renderer does not mutate the repo directly.
- Proof matters: screenshots, recordings, traces, and other artifacts are first-class outputs when workflows require them.

## Primary users

### Solo AI-native developers

Developers running several coding agents in parallel across multiple branches who need one place to understand what is active, blocked, or ready to review.

### Small teams with stacked or parallel delivery

Teams coordinating feature work, integration work, and review across several lanes, often with stacked PRs or branch dependencies.

### Operators building agent workflows on top of a local repo

People using ADE as the development backend for broader systems through the MCP server, CTO flows, automations, or external integrations.

## Core product concepts

### Lane

A lane is ADE's unit of isolated work. It usually maps to a git worktree and branch, and carries its own runtime, sessions, and status.

### Mission

A mission is a structured multi-step execution flow. Missions plan work, launch workers, track attempts and interventions, and keep a durable audit trail.

### CTO

The CTO is ADE's persistent project-aware operator. It acts as the long-lived entry point for project context, routing, and workflow supervision.

### Computer use

Computer use covers screenshot, browser, GUI, and proof-oriented flows where artifact capture and policy enforcement matter as much as the prompt.

### Context docs

`.ade/context/PRD.ade.md` and `.ade/context/ARCHITECTURE.ade.md` are generated agent-facing bootstrap cards. They are not the canonical source of truth; they compress the product and technical docs into bounded startup context.

## Product surfaces

### Run

Run is the execution control center for managed processes, tests, and project runtime controls.

### Lanes

Lanes shows isolated work surfaces, branch/worktree state, lane relationships, and lane-specific actions.

### Files

Files is ADE's repo-aware file browser and editor surface for working inside the selected workspace.

### Work

Work tracks active and historical sessions, including AI and terminal workflows.

### Missions

Missions is the structured orchestration surface for planning, delegation, execution, and intervention.

### PRs

PRs manages pull request creation, review state, queue/merge handling, and PR-linked operational workflows.

### CTO

CTO provides persistent project context, routing, and operator tooling across missions, lanes, and integrations.

### Automations

Automations runs background workflows on triggers with explicit guardrails and reviewable outputs.

### Settings

Settings owns provider setup, context generation preferences, memory controls, integrations, and system health.

## Core workflows

### Start focused work in an isolated lane

The user creates or selects a lane, opens the relevant session or files, and runs commands or agents against that lane's workspace.

### Coordinate parallel delivery

The user keeps several lanes active, tracks their status, inspects overlaps early, and moves work into PRs with explicit queue or merge handling.

### Launch a mission

The user describes a task, lets ADE plan it, reviews the plan if needed, then supervises workers, interventions, validation, and closeout.

### Route work through the CTO or MCP

The user or an external system enters through the CTO or the MCP server, asks for context, launches work, or supervises existing runs without bypassing ADE's state model.

## Current shipped state

ADE currently ships a substantial desktop workflow surface:

- lane management backed by git worktrees and branch-aware status, with support for creating child lanes from unstaged changes
- mission orchestration with structured run, step, attempt, and intervention state
- PR workflows with review/check awareness and queue-oriented handling
- persistent memory and context generation systems
- computer-use artifact capture
- provider-flexible AI execution
- an MCP server that exposes ADE-managed capabilities outside the UI

The product is still early beta. Responsiveness, operator clarity, and workflow hardening matter more than breadth for its next iterations.

## Operational expectations

- User-facing copy should be concrete and stateful.
- UI changes that touch workflows should preserve existing desktop patterns unless there is a clear product reason to change them.
- IPC, preload, shared types, and renderer behavior must stay aligned when contracts change.
- Context generation should prefer compact, non-overlapping cards over broad markdown dumps.
- For computer-use workflows, policy enforcement and artifact ownership must be implemented in code paths, not left to prompts alone.

## Non-goals

- Replacing the IDE with a full general-purpose editor platform
- Reframing ADE as a generic docs site or template app
- Depending on an ADE-hosted account layer to make core workflows work
- Treating prompt-only behavior as sufficient enforcement for policy-sensitive flows

## Success signals

- Operators can tell what each active lane, mission, and PR is doing without reading raw transcripts first.
- Parallel work conflicts are surfaced before merge time often enough to change operator behavior.
- Generated context docs are compact, distinct, and useful for agent startup.
- New provider or integration support can be added without changing ADE's operator model.

## Related docs

- Product surface details: [`docs/features/`](./features/)
- Technical architecture index: [`docs/architecture/SYSTEM_OVERVIEW.md`](./architecture/SYSTEM_OVERVIEW.md)
- Context generation ownership contract: [`docs/architecture/CONTEXT_CONTRACT.md`](./architecture/CONTEXT_CONTRACT.md)
- Sequencing and roadmap notes: [`docs/final-plan/README.md`](./final-plan/README.md)
