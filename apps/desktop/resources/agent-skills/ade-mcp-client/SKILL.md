---
name: ade-mcp-client
description: Use this skill when you reach ADE from outside through its MCP server (a cloud bot, a hosted agent, claude.ai, ChatGPT, a script) and need to pick a machine and project, use a device there, start a chat with an exact model, effort and permissions, learn when it finished, read its results and proof, or move files into a lane.
---

# Using ADE over MCP

ADE runs on the person's own machines. You reach them through one URL. Each
tool call is one short HTTP request, and every tool is also an `ade` command,
so `["<command>","--help"]` through the `ade` tool explains any of them.

A script or bot sends its own `User-Agent` (e.g. `my-bot/1.0`): the relay's
Cloudflare front refuses default library user agents (Python's urllib) with
"Error 1010: Access denied".

## 1. Find the machine and project

1. `machines_list`: pick one with `online: true` and `serving: true`. Pass its
   `key` as `machine`. A name works when it is unique.
2. `projects_list` with that `machine`: pass its `projectId` as `project`.
3. A device there: `["devices","--text"]` through the `ade` tool with that
   `machine` lists them; device commands take `--lane <lane there>`.
   `--machine` and `devices use` are refused: pick the machine with `machine`.

**Device work (an iPhone simulator, an emulator) stays inside ADE.** Best:
`chat_start` a chat whose prompt asks for it; the chat drives its own lane's
device and files proof. Driving it yourself: `["apple","start","--lane",
"<lane>"]`, then `apple` verbs with that same `--lane`, in ONE lane. Each lane
boots its own simulator, so never spread device work over many lanes. Never
`ios-sim open-device` or `--window`/`--foreground` (they open Simulator.app,
which gives every booted simulator a window on the person's screen; MCP
refuses them). `["apple","screenshot","--lane","<lane>"]` shows the screen;
`["apple","stop","--lane","<lane>"]` when done.

`chat_start` and `lanes_create` refuse to run without them, because the default
project changes as the person works. Reads default to the last opened project,
and every result starts with `[machine: …]` and `[project: …]`, so check them.

A chat id finds its own project and machine. `chat_status`, `chat_read`,
`chat_send`, `chat_wait`, `chat_events` and the others need only `session`.

## 2. Start a chat

```json
{"name":"chat_start","arguments":{
  "machine":"<key>", "project":"<projectId>",
  "prompt":"Fix the flaky checkout test",
  "provider":"claude", "model":"anthropic/claude-opus-5-5",
  "reasoning_effort":"high"
}}
```

- `permission_mode` defaults to `full-auto`, the highest level for each
  provider. `bypass` and `bypassPermissions` mean the same thing.
- A new lane is made unless you pass `lane` (from `lanes_list` or
  `lanes_create`). `lane_name` and `base` shape a new one.
- `instance` picks the provider account (`usage_limits` lists them).
- `dry_run: true` shows what would launch and starts nothing.
- The answer gives the chat's real `model`, `reasoningEffort`,
  `permissionMode`, `laneId` and a `link` to hand the person.
- `chat_update` changes model, effort or permissions in place; the id stays.
- A lane on its own cloud computer: only when the `ade-cloud` prompt is
  listed (the account has it); that prompt has the steps and the rules.

## 3. Know when it is done

Pick by what your client can do. Both can be used together.

**Any client: `chat_events`.** It answers at once. Pass the `cursor` from the
last answer as `since`, and no change is missed, however long you wait between
calls:

```json
{"name":"chat_events","arguments":{"session":"<id>","since":412}}
```

Each answer has `phase` (`running`, `waiting`, `blocked`, `idle`) and `events`
(`turn_started`, `turn_completed`, `turn_failed`, `turn_interrupted`,
`input_needed`, `input_resolved`, `error`); without `since`, the newest.
`truncated: true`: more follow, call again with the new `cursor`. `gap: true`:
some events were missed; trust `phase`, and use `chat_read`.

`chat_wait` is the same idea with a short block: it answers within 25 s by
default, under the limit most clients put on one request. A timed-out wait is
an answer: call it again.

**A client that can be woken: `notify_url`.** Pass a public https URL and,
when it needs one, `notify_token` (sent as `Authorization: Bearer …`) to
`chat_start`. The chat's machine POSTs each time the chat goes idle, needs
input or fails, and retries a failed POST:

```json
{"event":"chat.idle","sessionId":"…","laneId":"…","title":"…","status":"idle","at":"2026-11-09T13:00:00.000Z"}
```

It lasts 7 days. The machine must be awake to send it. If it can't be armed,
the chat still starts, and the answer says `notify: {armed: false}`. A Grok Bot or other
routine that starts from a webhook URL and key fits this directly.

When a chat waits on the person, `inbox` shows the question and `chat_respond`
answers it, if the person told you to.

A chat that is gone says why: `state: "deleted"` with `deletedAt` and
`reopenable` (null when ADE could not check), or `state: "not_found"`.

## 4. Read results and proof

- `chat_read` for what it said, `diff_changes` and `diff_patch` for what it
  changed, `prs_*` for its pull request.
- `proof_review` with `session` returns the image inline. A video comes as a
  sheet of key frames. A tall page comes one page at a time: the result says
  `page` and `pages`, and `page: 2` shows the next. `y_from` and `y_to` cut any
  band. `ade-proof://` links open only inside ADE, so don't try to fetch them.

## 5. Move files in

`files_write` takes `lane`, `path` and `text` (or base64 with `base64: true`),
up to 256 KB a call. For more, send chunks with `offset` set to the bytes
already written; with `base64`, split the bytes, then encode each chunk on its
own. Each answer gives `bytes` and `sha256`: compare the last with yours. A
chunk at the wrong offset is refused and names the file's real size.

## Limits

- Secrets an agent printed are removed from what `chat_read` returns, but don't
  ask an agent to print one.
- A machine that is offline can't answer; the error names the ones that can.
- Lane scratch files belong in `.ade/tmp`.
