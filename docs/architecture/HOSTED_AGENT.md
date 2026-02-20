# Hosted Agent Architecture (DEPRECATED)

> **This document is deprecated as of 2026-02-19.**
>
> The hosted agent architecture has been replaced by a local-first AI integration layer powered by the Vercel AI SDK. ADE no longer requires a cloud backend for AI functionality.
>
> For the current AI architecture, see: [AI Integration](./AI_INTEGRATION.md)
>
> For the current system overview, see: [System Overview](./SYSTEM_OVERVIEW.md)

---

## What Changed

ADE previously used a cloud-hosted backend (AWS) with Clerk authentication, S3 mirror storage, SQS job queues, and Lambda workers to provide AI-powered features (narrative generation, conflict proposals, PR descriptions).

This has been replaced with:

1. **Vercel AI SDK** — Spawns Claude Code and Codex CLI tools as local subprocesses, using the user's existing subscriptions (Claude Pro/Max, ChatGPT Plus). No API keys required.
2. **MCP Server** — Exposes ADE's capabilities (lanes, packs, conflicts, tests) as tools that AI agents can call via the Model Context Protocol.
3. **AI Orchestrator** — A Claude session connected to the MCP server that plans and coordinates multi-step mission execution.

All AI processing now happens locally on the user's machine. No data leaves the local environment for AI purposes.

---

*This file is retained for historical reference. It will be removed in a future cleanup pass.*
