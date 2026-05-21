---
name: ade-cto-missions
description: Use this skill when operating ADE CTO, missions, coordinator tools, worker agents, Linear routing, multi-agent orchestration, or mission run inspection.
---

# ADE CTO and missions

## CTO

Use CTO commands for team-lead state and Work chats:

```bash
ade cto state --text
ade cto chats --text
ade help cto
```

## Missions

Use missions for orchestrated multi-step work:

```bash
ade missions list --text
ade missions launch --prompt "..." --manual --text
ade missions watch <mission-id> --text
ade missions graph <mission-id> --text
ade missions runs <mission-id> --text
```

## Coordinator and Linear

```bash
ade coordinator <tool> --help
ade linear workflows --text
ade linear run <workflow> --text
ade linear sync --text
```

## Operating rules

- Keep worker briefs small and specific.
- Inspect source docs and code for non-obvious conventions and past pitfalls.
- When polling long-running mission/worker state, return compact summaries instead of pasting full logs.
- If a worker result conflicts with repo evidence, inspect the files yourself before merging its conclusion.
