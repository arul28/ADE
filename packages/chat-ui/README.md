# @ade-dev/chat-ui

Embeddable React chat components over `@ade-dev/sdk`.

**Docs:** [Chat UI](https://www.ade-app.dev/docs/sdk/chat-ui) · [ADE SDK](https://www.ade-app.dev/docs/sdk/overview)

This package renders an agent conversation for **your** users, not for ADE
developers. There are no lanes, projects, repos, or worktrees in any prop or
any string it can display. Tool activity is renamed through a label map, so a
customer sees "Searching your invoices…" where the agent ran `server.tool`.

- Zero runtime dependencies. React and React DOM are peers; `@ade-dev/sdk` is an
  optional peer used for types only.
- Theming is CSS custom properties only — no Tailwind, no class overrides.
- Every component is importable standalone; `<AdeChat>` is one assembly of them.

```bash
npm install @ade-dev/chat-ui
```

```tsx
import { AdeChat, createTheme } from "@ade-dev/chat-ui";

<AdeChat
  client={client}
  threadKey="support-42"
  labels={{ map: { "server.*": "Looking that up…" } }}
  theme={createTheme({ accent: "#7c5cff", background: "#0e0f13" })}
/>;
```

## Layout

```
packages/chat-ui/
  src/
    index.ts                     public surface
    sdkTypes.ts                  copied SDK contract (see below)
    AdeChat.tsx                  composed default
    composer/
      Composer.tsx
      composerState.ts           pure send/steer/key decisions
    transcript/
      Transcript.tsx             scroll container + row views + ActivityIndicator
      ToolChip.tsx
      ApprovalCard.tsx           inline approval card
      transcriptRows.ts          ported row collapsing/grouping
      markdown.tsx               dependency-free markdown renderer
    models/
      ModelPicker.tsx            rail + search + grouped list
      ProviderCard.tsx           ProviderCard, ProviderCards
      modelSearch.ts             ported scoring + provider grouping
    activity/labels.ts           label map, wildcards, phases, elapsed
    theme/
      createTheme.ts             token generator
      styles.ts                  the stylesheet
      AdeChatStyles.tsx
    context/AdeChatContext.tsx   provider + useAdeProviders + useAdeThread
  examples/
    fakeClient.ts                typed in-memory client
    basic.tsx                    full assembly, both shapes
  test/                          225 tests
```

Ported files carry a provenance header naming their ADE desktop source and what
was trimmed. `transcriptRows.ts` and `modelSearch.ts` are ports;
`Composer.tsx` and the model picker components are fresh implementations that
follow the desktop interaction/visual structure without inheriting its props.

## Components

### `<AdeChat>`

Transcript above, composer with the model rail below. No header bar.

| Prop | Type | Default | |
|---|---|---|---|
| `client` | `AdeChatClient` | — | required |
| `threadKey` | `string` | — | changing it opens a different conversation |
| `defaultModelId` / `modelId` | `string` | — | uncontrolled / controlled selection |
| `onModelChange` | `(model: ModelDescriptor) => void` | — | |
| `labels` | `ActivityLabelConfig` | — | |
| `theme` | `Partial<AdeChatTheme>` | — | usually `createTheme(...)` |
| `disableStyles` | `boolean` | `false` | skip the injected stylesheet |
| `placeholder`, `sendOnEnter`, `onRequestAttachment` | | | forwarded to `<Composer>` |
| `hideToolCalls`, `hideReasoning`, `renderMarkdown`, `emptyState` | | | forwarded to `<Transcript>` |
| `approvals` | `{ render?, labels? }` | — | approval card wording, or a replacement card |
| `hideModelPicker` | `boolean` | `false` | when the host pins a model |
| `className` | `string` | — | |

The approval card itself is not opt-in. A provider that asks for permission
parks its turn until someone answers, so a host that drew nothing would show a
conversation that had silently stopped. `approvals` changes only how it looks.

### `<Composer>`

| Prop | Type | Default | |
|---|---|---|---|
| `onSend` | `(input: SendInput) => void \| Promise<void>` | — | required |
| `onSteer` | same | — | omit to disable steering entirely |
| `onInterrupt` | `() => void \| Promise<void>` | — | omit to hide Stop |
| `status` | `"idle" \| "running" \| "error"` | `"idle"` | |
| `ready` | `boolean` | `true` | false while the thread resolves |
| `disabled` | `boolean` | `false` | |
| `value` / `onValueChange` | `string` / `(v) => void` | — | controlled draft |
| `placeholder` | `string` | `"Send a message…"` | |
| `sendOnEnter` | `boolean` | `true` | false swaps to Cmd/Ctrl+Enter |
| `autoFocus` | `boolean` | `false` | |
| `maxRows` | `number` | `12` | autosize ceiling |
| `onRequestAttachment` | `() => Promise<ChatAttachment[] \| null> \| …` | — | omit to hide the button |
| `attachments` / `onAttachmentsChange` | | — | controlled staging |
| `modelRail` | `ReactNode` | — | slot for the model rail |
| `actions` | `ReactNode` | — | extra controls |
| `error` | `string \| null` | — | |
| `className` | `string` | — | |

Submitting during a running turn dispatches `onSteer`, never a second `onSend`.
Enter sends, Shift+Enter is a newline, IME composition never submits, Escape
interrupts a running turn. A failed send restores the draft rather than losing
it.

### `<Transcript>`

| Prop | Type | Default | |
|---|---|---|---|
| `rows` | `readonly TranscriptRow[]` | — | from `buildTranscriptRows()` or `useAdeThread()` |
| `status` | `"idle" \| "running" \| "error"` | `"idle"` | drives the live indicator |
| `labels` | `ActivityLabelConfig` | — | |
| `hideToolCalls` | `boolean` | `false` | hides chips entirely |
| `hideReasoning` | `boolean` | `false` | |
| `expandReasoning` | `boolean` | `false` | reasoning starts collapsed |
| `renderMarkdown` | `(text: string) => ReactNode` | built-in | |
| `onApprove` | `(itemId, decision) => void \| Promise<void>` | — | omit to render approval cards read-only |
| `approvals` | `{ render?, labels? }` | — | custom approval card and button wording |
| `emptyState` | `ReactNode` | `"No messages yet."` | |
| `className` | `string` | — | |

Card set: user text, assistant markdown, collapsed reasoning, tool chips,
approvals, error. Plain overflow scroll (no virtualization in v1), pinned to
the bottom and released as soon as the reader scrolls up.

### Approval cards

An `approval_request` becomes an `approval` row and renders inline where the
request happened, not as a modal — the reader needs to see what the agent was
doing when it asked. `pending_input_resolved` settles the same card in place,
and a turn that ends unanswered marks it expired. The card never disappears and
never takes focus from the composer.

Two rules keep a live card from being drawn dead, which is a hang rather than a
cosmetic bug — the buttons go read-only while the runtime still waits:

- **A turn ending is `done`, or a `status` of `completed` / `failed` /
  `interrupted`. Never `error`.** An `error` ends no turn on either layer: an
  OpenCode per-tool failure emits one and keeps streaming, and the Codex
  planning-approval guard emits one to decline a single request.
- **A restored row is live by construction.** `pendingApprovals()` is the
  engine's authoritative "still blocked right now" list, read after the history
  window, so no ending in that history expires it. Only an explicit resolution
  settles it. Restored rows sort in at the instant they were read rather than
  being appended.

| Decision | Button | Meaning |
|---|---|---|
| `accept` | Allow once | this call only |
| `accept_always` | Always allow | stop asking for this in this session |
| `reject` | Reject | refuse, and let the model hear why |

`requestKind` of `question`, `structured_question`, `plan_approval` or
`model_selection` renders read-only: those want prose or a choice this surface
cannot carry, and `@ade-dev/sdk`'s own `approve()` refuses them with
`invalid_option` rather than sending a verdict the request cannot use. A thread
with no `approve` also renders read-only, with a line saying the host cannot
answer.

### `<ModelPicker>`

| Prop | Type | Default | |
|---|---|---|---|
| `value` | `string \| null` | — | selected model id |
| `onChange` | `(model: ModelDescriptor) => void` | — | required |
| `models` / `providers` | arrays | — | supply data directly; omit to read from the client |
| `client` | `AdeChatClient` | context | used only when data is not supplied |
| `searchable` | `boolean` | `true` | |
| `renderProviderNotice` | `(status, providerId) => ReactNode` | — | drawn under an unusable provider group |
| `className` | `string` | — | |

Models group under their provider; rows are disabled when the provider is not
installed/authenticated or the model reports `available: false`.

### `<ProviderCard>` / `<ProviderCards>`

Free-floating — the host decides placement.

| Prop | Type | |
|---|---|---|
| `status` | `ProviderStatus` | required on `ProviderCard` |
| `renderAction` | `(command, kind: "install" \| "login") => ReactNode` | replace the copy button |
| `onCopy` | `(command: string) => void \| Promise<void>` | override the clipboard write |
| `showDetail` | `boolean` (default `false`) | add a line with the version and a truncated binary path |
| `className` | `string` | |

`<ProviderCards>` adds `statuses`, `client`, and `onlyNeedsAttention` (default
`true`) and renders one card per provider needing action. `showDetail` is
forwarded to every card.

A missing provider reads "Not installed" only when `source` is `"probed"` —
a runtime looked and found nothing. When the status was derived from the model
catalog nobody looked, so the card says "Not detected" instead. Telling someone
to install a CLI they already have is the failure that distinction removes.

## Activity labels

```ts
labels={{
  map: {
    "server.tool": { running: "Searching…", done: "Searched", error: "Search failed" },
    "server.*": "Talking to your account…",   // string = running phase only
    "*": "Working…",
  },
  resolve: (source) => source.tool === "x" ? "Custom" : null,  // wins over map
  icons: { "server.*": <ServerIcon /> },
  thinkingLabel: "Thinking…",
  elapsedAfterMs: 3000,
}}
```

Resolution order: `resolve()` → exact key → longest wildcard prefix → `*` →
the raw tool name. A bare string labels the running phase only, so a finished
chip never keeps saying "Searching…". Labels apply to the live thinking
indicator, tool chips, and error text. An elapsed suffix appears after 3s of
running and is formatted `45s` / `1m 35s` / `1h 5m`. `prefers-reduced-motion`
is respected in both CSS and the indicator's animated ellipsis.

## Theming

`createTheme({ accent, background, foreground, muted, danger, success, radius, fontFamily, monoFontFamily, fontSize, space, scheme })`
returns the full token set; hovers, borders and subtle tints are derived. Pass
it to `theme`, or set the tokens yourself on any ancestor.

```
--adechat-bg            --adechat-accent           --adechat-radius
--adechat-bg-subtle     --adechat-accent-fg        --adechat-radius-sm
--adechat-bg-raised     --adechat-accent-subtle    --adechat-font
--adechat-fg            --adechat-border           --adechat-font-mono
--adechat-muted         --adechat-border-strong    --adechat-font-size
--adechat-danger        --adechat-hover            --adechat-space
--adechat-danger-subtle --adechat-success
```

Light/dark is inferred from the background's luminance (override with
`scheme`). Non-hex colors (`var(--brand)`, `color-mix(...)`) pass straight
through; derived tints are only computed for hex inputs.

## What `adaptSdkClient` produces

`src/sdkTypes.ts` is the *view* contract this package renders against — a copy,
not an import, so the package is standalone and any client shape can satisfy it.
`src/adapters/sdkClient.ts` bridges a real `@ade-dev/sdk` client onto it and does
import that package's types (type-only, and `@ade-dev/sdk` is an optional peer, so
nothing reaches the bundle).

The list below is the adapter's **output** contract: what every component here
may assume about the client it is handed. Write your own client — a WebSocket
proxy, an Electron IPC bridge, a fake — and these are the rules to meet.

One such client is checked here rather than described: `test/electronBridge.test.tsx`
assigns `createAdeIpcClient()` from `@ade-dev/sdk/electron/renderer` to
`SdkLikeChatClient` with no cast, then drives a full turn through
`registerAdeIpc` and `<AdeChat>`. A drift between that bridge and this contract
is a typecheck failure, not a runtime surprise.

1. **`client.providers.status()`** resolves `ProviderStatus[]` with `installed`
   and `authenticated` as separate booleans. Both true means selectable.
   `loginCommand` / `installCommand` are copy-pasteable shell strings.
   `source` says whether `installed` was probed or derived, and the card's
   wording depends on it.
2. **`client.providers.onChange(cb)`** fires with the *full* status list (not a
   delta) and returns an unsubscribe function. A status change may also change
   the model catalog, so the hook re-reads `models.list()` after each one.
   `refresh()` is optional and is never called by a poll.
3. **`client.models.list()`** resolves the full catalog. `providerId` must match
   a `ProviderStatus.id`; models whose provider has no status entry still render
   (grouped under the raw id) but are never selectable.
4. **`client.threads.open(key, opts)`** is idempotent per key within a session —
   re-opening the same key returns a handle onto the same conversation.
5. **`thread.history()`** returns envelopes in transcript order. Ordering is
   envelope-based (`sequence`, then `timestamp`); provider clocks are not
   trusted. Events emitted while `history()` is in flight must also reach the
   `"event"` subscriber — the hook de-duplicates the overlap on
   `sessionId:sequence:timestamp:type` and then re-sorts, so a live envelope
   that beat the page still renders in its own place. The canonical definition
   of that key is `envelopeDedupeKey` in `@ade-dev/sdk`
   (`src/electron/protocol.ts`); this package mirrors it because the SDK is an
   optional peer.
6. **Streaming text** may be sent either as growing snapshots or as deltas; both
   collapse correctly. Chunks of one message must share a `messageId`, or
   failing that a `turnId` + `itemId`.
7. **`tool_result` must reuse its `tool_call`'s `itemId`**, or carry a matching
   `logicalItemId` when the provider renumbers items. Otherwise the result
   renders as a second, orphaned chip.
8. **`thread.on("status")`** reports `running` for the whole duration of a turn
   and returns to `idle` when it ends. The composer's send-vs-steer decision is
   driven entirely by this.
9. **`steer()` does not start a turn.** It delivers into the running one and
   must be safe to call while `status.state === "running"`.
10. **Unknown event types are ignored, not rendered.** The SDK may add event
    kinds without breaking this package, but anything it wants drawn here needs
    a matching row kind.
11. **`approval_request` blocks the turn until it is answered.** An
    `approval_request` and its `pending_input_resolved` must share an `itemId`
    (or a matching `logicalItemId`), and a turn that ends without an answer
    must emit `done`, `error`, or a terminal `status` so the card can settle.
12. **`thread.approve` and `thread.pendingApprovals` are optional.** A client
    that omits `approve` gets a read-only card with a line saying why, never a
    throw. `pendingApprovals()` is read once on open, so a reload restores the
    cards a lost live stream would otherwise have taken with it.

## What `@ade-dev/sdk` actually returns

The adapter exists because the two shapes do not meet. The differences that
catch people writing their own proxy:

- `providers.status()` returns a **`Record<string, ProviderStatus>` keyed by
  provider id**, not an array.
- A status record calls the id `provider`, not `id`, and carries
  `available` / `requiresConfiguration` / `modelCount` / `stale` — fields this
  package folds into `installed` and a `detail` sentence.
- A catalog entry calls its provider `provider` and its usability
  `isAvailable`, where the view contract uses `providerId` and `available`.
- `threads.open(key, opts)` takes the SDK's own option names (`provider`,
  `model`), which `adaptSdkClient` maps from `providerId` / `modelId`.
- `send(text, { attachments })` is positional, and an attachment is a
  `{ path }` file ref rather than the view's `ChatAttachment`.
- `on("status")` and `on("usage")` deliver raw envelopes; the adapter maps them
  to `{ state, turnId }` and `{ inputTokens, … }` and drops anything that maps
  to nothing.

## Development

Requires Node 22 (`/opt/homebrew/opt/node@22/bin` on macOS).

```bash
npm install            # in packages/chat-ui
npm test               # vitest, 225 tests
npm run typecheck      # tsc --noEmit
npm run build          # tsup → dist/ (ESM + CJS + d.ts)
```

From the repo root: `npm run test:chat-ui`, `npm run build:chat-ui`.

## License

MIT. See [LICENSE](./LICENSE). ADE itself remains AGPL-3.0-only; see the [ADE Runtime Embedding Exception](https://github.com/arul28/ADE/blob/main/RUNTIME-EMBEDDING-EXCEPTION.md) for shipping the runtime binary in your app.
