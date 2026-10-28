# ADE MCP eval

How real models use ADE MCP's tools. Each case is a request an outside agent
gets (claude.ai, Claude Code, ChatGPT…), for example "what's waiting on me?" or
"approve everything" or "check CI on my PR". The runner plays it against ADE
MCP's **real** instructions and tool list, built from source, and grades the
tool calls the model makes. Change a tool's text, run the eval, and compare.

It follows T3 Code's eval (pingdotgg/t3code#24635): cases are data, they come
from real requests and real mistakes, and CI never calls a model.

## How it works

- `fakeServer.ts` is a stdio MCP server. It builds `initialize` and `tools/list`
  with the real `createRemoteMcpProtocol`, so a model sees exactly what ADE
  serves (including `machine` and `machines_list`; it passes a stub router).
  A tool call goes through the real typed tool's `build`, the real command
  policy, and the real `shape` and `next`. Only the command's output is
  scripted. Lane and chat ids that don't exist fail the way the CLI fails.
- `fixtures.ts` is the starting world: two projects (`ADE`, `website`), three
  lanes, two chats, two PRs, usage, and an empty inbox. The data is invented.
- `cases.ndjson` holds one case per line. Each has an `id`, a `why` (the request
  or mistake it reproduces), a `scope` (`read` or `write`), a `prompt`,
  optional `results` (scripted output per tool, served in order, with the last
  one repeating; `{"$error": "…"}` fails the command), optional `ade` (output
  for the raw tool, matched by regex) and a `grade`.
- `graders.ts` checks the calls and the reply. A grade can use `expect` (a tool
  with matching args, at least `count` times), `forbid` (tools that must not
  be called, usually `ade` when a typed tool fits), `maxCalls` (catches
  polling loops), `order`, and `answer` (a regex on the final reply).
- `run.ts` drives `claude -p` with the fake server as its only MCP server and
  no built-in tools (`--tools ""`, `--strict-mcp-config`,
  `--allowedTools mcp__ade`), a short chat-app system prompt, and a clean
  environment (no `ADE_*` or `CLAUDE_CODE_*`). It uses your Claude
  subscription, so you don't need an API key.

## Run it

```sh
cd evals/ade-mcp
npm run eval -- --model haiku                          # every case, 1 sample
npm run eval -- --model haiku,sonnet --concurrency 6
npm run eval -- --model sonnet --case inbox-answer-option,approve-everything --samples 3
npm run typecheck
```

Each run writes one JSON file per sample (calls, reply, the full stream) and a
`summary.json` to `runs/<time>/`, or to `--out <dir>`.

## Cost

A full pass (22 cases, 1 sample) costs about $0.03 with Haiku and $0.30 with
Sonnet in API-equivalent dollars. On a subscription it uses that much of the
limit. Each case runs in 5 to 40 seconds.

## When to add a case

- A real agent made a mistake with ADE MCP's tools, or a person's request went
  wrong. Write the case from that request. Check that it fails on the text
  that caused the mistake and passes on the fix.
- You add or change a tool. Add the request it exists for, plus a control case
  that should not call it.

Rules: one behaviour per case. Grade what matters to the person (the right
tool, id and decision), not the wording. Use invented data only, never a real
person's projects, chats or paths. A world flaw (a fixture that contradicts the
case) makes a model look wrong for the eval's own reasons, so script every
tool the case leans on.

## Results

On this branch's text (1 sample per case, 2026-10-28):

| Model | Cases passing |
| --- | --- |
| Claude Haiku | 22 of 22 |
| Claude Sonnet | 22 of 22 |

Two text fixes came out of the runs. Haiku passed lane names where lane ids go
(`read-file`), so the lane input now says "Lane id from lanes_list, not its
name". Haiku also waited with `for: terminal` on chats that only go idle, so
`terminal` is gone from chat_wait's options.
