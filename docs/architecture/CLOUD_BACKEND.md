# Cloud Backend Architecture (DEPRECATED)

> **This document is deprecated as of 2026-02-19.**
>
> ADE no longer uses a cloud backend. The AWS infrastructure (API Gateway, Lambda, DynamoDB, S3, SQS) and Clerk authentication have been removed entirely.
>
> ADE is now fully local-first with AI powered by the Vercel AI SDK using existing CLI subscriptions.
>
> For the current AI architecture, see: [AI Integration](./AI_INTEGRATION.md)
>
> For the current system overview, see: [System Overview](./SYSTEM_OVERVIEW.md)

---

## What Changed

ADE previously deployed a serverless AWS stack via SST for:
- Clerk OAuth authentication (GitHub/Google sign-in)
- API Gateway + Lambda API endpoints
- SQS job queuing for async AI work
- S3 storage for mirror blobs, manifests, and artifacts
- DynamoDB for project/lane/job metadata
- LLM gateway for model invocation

All of this infrastructure has been removed. AI functionality is now provided locally through:

1. **Vercel AI SDK** — Unified interface for spawning AI agent CLIs (Claude Code, Codex) using existing user subscriptions.
2. **MCP Server** — Local JSON-RPC server exposing ADE tools to AI agents.
3. **AI Orchestrator** — Local Claude session for mission planning and coordination.

No cloud services, authentication, or API keys are required for AI features. The `infra/` directory is no longer part of the active codebase.

---

*This file is retained for historical reference. It will be removed in a future cleanup pass.*
