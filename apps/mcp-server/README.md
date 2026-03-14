# ADE MCP Server

`apps/mcp-server` exposes ADE local-core capabilities over MCP (JSON-RPC 2.0 on stdio) for orchestration clients.

## Scripts

```bash
npm run dev -- --project-root /absolute/path/to/repo
npm run build
npm run typecheck
npm run test
```

## Tool Surface

- `spawn_agent`
- `read_context`
- `create_lane`
- `check_conflicts`
- `merge_lane`
- `ask_user`
- `run_tests`
- `get_lane_status`
- `list_lanes`
- `commit_changes`

## Resource Surface

- Pack exports: `project`, `lane`, `feature`, `conflict`, `plan`, `mission` (`lite|standard|deep`)
- Lane status snapshots
- Lane conflict summaries

## Local Smoke Test

Run a direct stdio round-trip:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","identity":{"role":"orchestrator","allowMutations":true,"allowSpawnAgent":true}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.cjs --project-root /absolute/path/to/repo
```

## Claude CLI Client

Add the server:

```bash
claude mcp add ade -- node /absolute/path/to/ADE/apps/mcp-server/dist/index.cjs --project-root /absolute/path/to/repo
```

Then verify:

```bash
claude mcp list
```

## Codex CLI Client

Add the server:

```bash
codex mcp add ade -- node /absolute/path/to/ADE/apps/mcp-server/dist/index.cjs --project-root /absolute/path/to/repo
```

Then verify:

```bash
codex mcp list
```
