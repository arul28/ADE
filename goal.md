# Goal: ADE TUI — Universal Click + Multi-Chat Middle Pane

You are implementing two interlocking TUI features for the ADE CLI. Read this whole brief before touching code. Worktree is `/Users/admin/Projects/ADE/.ade/worktrees/deeplinks-d52aa89e/`. Do not switch lanes.

---

## Why we're doing this

The ADE TUI today gives you one chat at a time in the middle pane. Power users running agents across multiple lanes constantly want to watch two, three, or six chats stream in parallel — currently they tile multiple TUI instances side by side, which is wasteful and forces them to manage N copies of the same drawer + right pane.

The other long-standing irritation: mouse support is partial. The drawer, chat text selection, and a handful of right-pane targets accept clicks; most things (model picker, approval prompts, slash/mention palettes, lane-details actions, lane-delete form, prompt-history nav) don't. Add multi-chat without expanding click coverage and the new feature is unusable for mouse-driven users.

Ship them together:
1. **Universal click** — every keyboard handler gets a matching mouse hit-test, with hover-highlight so users can see what's clickable before committing.
2. **Multi-chat middle pane** — middle splits into 1–6 chat tiles in fixed grids; chats can be from any lane; focus drives prompt routing and right-pane context.

---

## TL;DR feature spec

**Universal click**
- Add hit-testing for every existing keyboard action across drawer, right pane, palettes, prompt area, and overlays.
- Build a `HitTestRegistry` so components register their bounds + handlers declaratively; future components opt in for free.
- Enable terminal mouse mode 1003 (any-event) so we receive `move` events and can highlight whatever's under the cursor.

**Multi-chat middle pane**
- Middle pane state: `multiView = { tiles: Array<{ sessionId, laneId }>, focusedIndex: number } | null`.
- Up to 6 tiles. Hardcoded layouts: 1=full, 2=2 cols, 3=3 cols, 4=2×2, 5=2-top/3-bot, 6=3×2.
- Chats can come from any lane (cross-lane mixing). State is global to the TUI and **ephemeral** — never persisted across restart.
- Add flow: shortcut while chat pane focused → enter "add-mode" (sidebar focused, non-sidebar regions dimmed, banner overlay) → arrow-nav across all lanes' chats → `Enter` adds, `Esc` cancels.
- Remove flow: shortcut or click `×` in tile header. Dropping below 2 tiles exits multi-view entirely.
- No duplicate chats — adding an already-open chat refocuses the existing tile.
- Focused tile is the source of truth: bottom prompt routes to it; right pane / status / sidebar lane highlight follow it.
- Concurrent streaming: every open tile streams events live whether focused or not.

**Extras (locked picks)**
- `×` affordance in each tile header for mouse-driven removal.
- Status-bar grid mini-map (e.g. `▣▢ / ▢▢`).
- Per-tile prompt history recall (up/down only cycles the focused tile's prompts).
- Drag a sidebar chat onto the middle pane to add (bypasses add-mode).

---

## Current architecture you must understand first

The TUI is **Ink v5.2.1** (React for terminal). Entry point: `apps/ade-cli/src/tuiClient/cli.tsx`. Top-level component: `AdeCodeApp` in `apps/ade-cli/src/tuiClient/app.tsx`. That single file is ~8000 lines and owns the entire app's state, focus, mouse parsing, and layout. The rest of `tuiClient/` is split into focused components and helpers.

### Layout (read `app.tsx` lines ~7626–7800)

Root is `<Box flexDirection="column" height={rows}>`:

```
┌────────────────────────────────────────────────────────┐
│ <Header />                                  fixed 1-2  │
├────────────────────────────────────────────────────────┤
│ {goal-banner conditional}                   0 or 1     │
├──────────┬──────────────────────────────┬──────────────┤
│ Drawer   │ (middle: <ChatView />)       │  RightPane   │
│ 32 cols  │ flexGrow:1                    │ 30–42 cols   │
│ (left)   │                              │              │
│          │                              │              │
├──────────┴──────────────────────────────┴──────────────┤
│ <Box borderStyle="round"> prompt input </Box>          │
├────────────────────────────────────────────────────────┤
│ <ModelStatus /> <FooterControls />          fixed 1-2  │
└────────────────────────────────────────────────────────┘
```

Constants in `app.tsx` ~1508–1511: `DRAWER_PANE_WIDTH = 32`, right pane is computed `30–42`, middle gets the remainder (`min 24`).

The chat row budget (~line 2514):
```ts
const chatRowBudget = Math.max(4, rows - 8 - (promptRows.length - 1) - statusRows - goalBannerRows);
```
You'll need to subdivide this budget across grid rows when multi-view is active.

### Focus / pane state (read `app.tsx` ~1733–1776)

```ts
type PaneFocus = "chat" | "drawer" | "details";
const [activePane, setActivePane] = useState<PaneFocus>("chat");
const activePaneRef = useRef<PaneFocus>("chat");
```

The single `useInput` handler (~line 3400+) branches on `activePane` to dispatch keystrokes. **You will extend `PaneFocus` with `"addMode"`** and add `multiView.focusedIndex` for tile focus (the chat pane itself owns the sub-focus).

### Mouse (read `app.tsx` `parseTerminalMouseInput` + hit-test helpers ~1557–1620)

The custom parser handles SGR (`\x1b[<…M/m`), X10, and RXVT escape sequences. It's enabled at startup by writing mode-enable sequences to stdout. Today's modes used:
- `\x1b[?1000h` — basic click tracking
- `\x1b[?1002h` — drag tracking
- `\x1b[?1006h` — SGR extended (for x/y > 223)

**You will add `\x1b[?1003h`** (any-event tracking, i.e. mouse-move without buttons) and disable it cleanly on exit. Reference: <https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Mouse-Tracking>.

The current hit-test pattern is a family of per-pane helpers with hardcoded Y offsets, e.g.:

```ts
// app.tsx ~1557
export function laneDetailsActionIndexForMouseLine(y, actionCount) {
  if (y == null || actionCount <= 0) return null;
  const firstActionLine = 18;
  const index = y - firstActionLine;
  return index >= 0 && index < actionCount ? index : null;
}
```

This pattern repeats in `formFieldIndexForMouseLine`, `setupPaneRowIndexForMouseLine`, `subagentIndexForPaneLine`. **You will replace these with a unified registry (see Feature 1 below).** Don't delete the old helpers in one go — migrate component by component; once a component is on the registry, delete its old helper.

### Chat model (read `apps/desktop/src/shared/types/chat.ts` ~725–773)

A chat is an `AgentChatSession`:
```ts
type AgentChatSession = {
  id: string;             // session ID (unique per chat)
  laneId: string;         // lane it belongs to
  provider: "claude" | "codex" | "cursor" | "droid" | "opencode";
  model: string;
  status: "active" | "idle" | "ended";
  sessionProfile?: …;
  permissionMode?: …;
  interactionMode?: …;
  // …
};
```

### Single-source streaming today (read `app.tsx` ~580, ~1190)

```ts
const [streaming, setStreaming] = useState(false);   // GLOBAL flag — must die
…
connection.onChatEvent((envelope) => {
  if (envelope.sessionId !== activeSessionIdRef.current) {
    refreshState({ hydrateHistory: false });          // silently drop the event UI-side
    return;
  }
  if (event.type === "status" && event.turnStatus === "started") setStreaming(true);
  …
});
```

This is the single biggest blocker for multi-chat. Two changes:
1. `streaming: boolean` → `streamingBySessionId: Record<string, boolean>` (or a `Map`).
2. The early-return filter widens from `=== activeSessionIdRef.current` to `openSessionIds.has(envelope.sessionId)`, where `openSessionIds` is `multiView ? new Set(tiles.map(t=>t.sessionId)) : new Set([activeSessionIdRef.current])`.

### ChatView (read `apps/ade-cli/src/tuiClient/components/ChatView.tsx`)

```ts
function ChatView({
  events, activeSession, streaming, interrupted,
  expandedLineIds, maxRows, scrollOffsetRows, selection,
  width, laneName, projectName, provider, notices, …
})
```

No local state for messages — fully driven from parent. **You will extend the props with `focused?: boolean` (for tile-level focus rendering) and `onRemove?: () => void` (for the `×` affordance).** Internal logic computes `RenderedChatRow` from aggregated blocks (`aggregateChatBlocks()` in `aggregate.ts`).

### Submit / prompt routing (read `app.tsx` `submitPrompt` ~4050)

```ts
async function submitPrompt(value: string) {
  // ...validate, parse slash commands, extract attachments
  const sessionId = activeSessionIdRef.current;     // <-- this line is the only routing
  await sendChatMessage(conn, sessionId, text, attachments);
  setStreaming(true);
  await refreshState();
}
```

In multi-view, replace the `sessionId` line with:
```ts
const sessionId = multiView
  ? multiView.tiles[multiView.focusedIndex].sessionId
  : activeSessionIdRef.current;
```

### Persistence (read `apps/ade-cli/src/tuiClient/state.ts`)

`~/.ade/ade-code-state.json` stores `lastChatByLane` and `lastChatByProjectLane` (per-lane last-active session). Debounced 500ms saves via `saveAdeCodeProjectState()`.

**Do not** add `multiView` here. Multi-view is in-memory only.

---

## Feature 1: Universal click — detailed design

### Step 1: Hit-test registry

Create `apps/ade-cli/src/tuiClient/hitTestRegistry.ts`:

```ts
export type HitRect = { x: number; y: number; w: number; h: number };

export type HitTarget = {
  id: string;                 // stable id for the click target
  rect: HitRect;              // absolute terminal coordinates (1-based)
  onClick?: (ev: MouseEvent) => void;
  onHover?: (hovered: boolean) => void;
  zIndex?: number;            // higher wins on overlap (default 0)
};

export interface HitTestRegistry {
  register(target: HitTarget): void;
  unregister(id: string): void;
  hitTest(x: number, y: number): HitTarget | null;     // for clicks
  hoverTest(x: number, y: number): HitTarget | null;   // same lookup, used for hover state
  clear(): void;
}

// Backed by a flat array; linear scan is plenty fast (<500 targets, called per mouse event ≤ 60Hz).
export function createHitTestRegistry(): HitTestRegistry { … }
```

Wire one registry instance into `app.tsx` via a React context (`HitTestProvider`). Components grab the registry through a `useHitTest()` hook and call `register` in a `useEffect` (cleanup unregisters). Use `useLayoutEffect` if you find render-order races between mouse event and registration.

Inside `app.tsx`'s `parseTerminalMouseInput` consumer:
```ts
case "click": {
  const target = registry.hitTest(mouse.x, mouse.y);
  if (target?.onClick) target.onClick(mouse);
  break;
}
case "move": {
  const target = registry.hoverTest(mouse.x, mouse.y);
  if (target?.id !== currentHoveredId) {
    currentHovered?.onHover?.(false);
    target?.onHover?.(true);
    currentHoveredId = target?.id ?? null;
    setHoveredId(currentHoveredId);    // triggers re-render so highlight updates
  }
  break;
}
```

### Step 2: Enable mode 1003 (mouse move)

In the mouse-enable block in `app.tsx`:
```ts
process.stdout.write("\x1b[?1003h");   // any-event tracking (includes mouse-move)
```
And on shutdown:
```ts
process.stdout.write("\x1b[?1003l");
```

Note: mode 1003 generates events for *every* cursor movement, which can be heavy. Throttle the hover-test path with `requestAnimationFrame`-equivalent (e.g. setImmediate-based coalescing) if profiling shows it dominating render cost.

### Step 3: Hover styling

Components decide their own hover render. Standard pattern:
```tsx
const [hovered, setHovered] = useState(false);
useHitTest({ id, rect, onClick, onHover: setHovered });
return <Box backgroundColor={hovered ? "blueBright" : undefined}>…</Box>;
```

Use Ink's `Box backgroundColor` or `Text inverse` for the highlight — pick whichever reads better with the existing palette. Keep it subtle; the hover is meant to teach, not strobe.

### Step 4: Migrate components (full parity list)

Convert each of these to register hit-test rects and call their existing keyboard action on click. Source columns reference where the keyboard handler lives today.

| Pane              | Component / handler                                  | File:line (approx)            |
|-------------------|------------------------------------------------------|-------------------------------|
| Right pane        | Model picker rows + tab rail + favorite toggle (`f`) | `app.tsx` 7878–7937           |
| Right pane        | Model picker search (`/`)                            | `app.tsx` 7940–7970           |
| Right pane        | Lane-details actions (`Return`, t-toggle file tree)  | `app.tsx` 7979–8044           |
| Right pane        | List pane rows + scroll                              | `app.tsx` 8048–8056           |
| Right pane        | Lane-delete form radio (`1/2/3`, space/`f`)          | `app.tsx` 7750–7765           |
| Overlay           | Approval prompt accept/decline (`a`/`d`)             | `app.tsx` 7732–7735           |
| Overlay           | Mention palette nav + insert (up/down/Tab/Enter)     | `app.tsx` 8118–8142           |
| Overlay           | Slash palette nav + insert                           | `app.tsx` 8118–8142           |
| Bottom prompt     | Prompt-history recall (k/j or up/down in vim mode)   | `app.tsx` 7597–7603           |
| Bottom prompt     | Prompt submit (vim normal mode)                      | `app.tsx` 7605–7608           |
| Footer            | Status-line clickable model swap, etc.               | `ModelStatus`, `FooterControls` |
| Header            | Project / lane / chat title clickable to open palette| `Header` component            |

For each: the keyboard handler stays; clicks dispatch the same intent. After migration, delete the old `*IndexForMouseLine` helpers (~`app.tsx` 1557–1620).

### Step 5: Don't break what works

Things already mouse-wired (don't touch their behavior, just port them to the registry on the way through):

| Target                                        | File:line               |
|-----------------------------------------------|-------------------------|
| Drawer lanes/chats select                     | `app.tsx` 7096–7131     |
| Chat transcript text select (click/drag/release) | `app.tsx` 7181–7225  |
| Chat scroll wheel                              | `app.tsx` 7239–7245    |
| Prompt focus click                            | `app.tsx` 7083–7094     |
| Lane detail action click (existing partial)   | `app.tsx` 7141–7144     |
| Form field click                              | `app.tsx` 7156–7170     |
| Subagent transcript list click                | `app.tsx` 7175–7176     |

---

## Feature 2: Multi-chat middle pane — detailed design

### Step 1: State

In `app.tsx`:
```ts
type MultiViewTile = { sessionId: string; laneId: string };
type MultiViewState = { tiles: MultiViewTile[]; focusedIndex: number };

const [multiView, setMultiView] = useState<MultiViewState | null>(null);
const multiViewRef = useRef<MultiViewState | null>(null);
useEffect(() => { multiViewRef.current = multiView; }, [multiView]);

// Per-tile transient state
const [streamingBySessionId, setStreamingBySessionId] = useState<Record<string, boolean>>({});
const [scrollBySessionId, setScrollBySessionId] = useState<Record<string, number>>({});
const [selectionBySessionId, setSelectionBySessionId] = useState<Record<string, ChatTextSelection | null>>({});
const [promptHistoryBySessionId, setPromptHistoryBySessionId] = useState<Record<string, string[]>>({});

// Add-mode
const [addMode, setAddMode] = useState<{ cursorLaneId: string; cursorChatId: string | null } | null>(null);
```

### Step 2: Streaming refactor

Replace every reference to global `streaming` with `streamingBySessionId[sessionId]`. The places that set `setStreaming(true/false)` (in `submitPrompt`, `onChatEvent`) update the record instead:
```ts
setStreamingBySessionId(prev => ({ ...prev, [sessionId]: true }));
```

Widen the event subscription filter:
```ts
const openSessionIds = multiView
  ? new Set(multiView.tiles.map(t => t.sessionId))
  : new Set([activeSessionIdRef.current]);

if (!openSessionIds.has(envelope.sessionId)) {
  refreshState({ hydrateHistory: false });
  return;
}
```

### Step 3: Layout math

Create `apps/ade-cli/src/tuiClient/multiChatLayout.ts`:

```ts
export type TileRect = { x: number; y: number; w: number; h: number };

const PATTERNS: Record<number, ReadonlyArray<{ row: number; col: number; rowSpan: number; colSpan: number; rows: number; cols: number }>> = {
  1: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, rows: 1, cols: 1 }],
  2: [
    { row: 0, col: 0, rowSpan: 1, colSpan: 1, rows: 1, cols: 2 },
    { row: 0, col: 1, rowSpan: 1, colSpan: 1, rows: 1, cols: 2 },
  ],
  3: [
    { row: 0, col: 0, rowSpan: 1, colSpan: 1, rows: 1, cols: 3 },
    { row: 0, col: 1, rowSpan: 1, colSpan: 1, rows: 1, cols: 3 },
    { row: 0, col: 2, rowSpan: 1, colSpan: 1, rows: 1, cols: 3 },
  ],
  4: [ /* 2x2 */
    { row: 0, col: 0, rowSpan: 1, colSpan: 1, rows: 2, cols: 2 },
    { row: 0, col: 1, rowSpan: 1, colSpan: 1, rows: 2, cols: 2 },
    { row: 1, col: 0, rowSpan: 1, colSpan: 1, rows: 2, cols: 2 },
    { row: 1, col: 1, rowSpan: 1, colSpan: 1, rows: 2, cols: 2 },
  ],
  5: [ /* 2 top, 3 bottom — row 0 has 2 cells over a 6-col virtual grid (each spans 3); row 1 has 3 cells (each spans 2) */
    { row: 0, col: 0, rowSpan: 1, colSpan: 3, rows: 2, cols: 6 },
    { row: 0, col: 3, rowSpan: 1, colSpan: 3, rows: 2, cols: 6 },
    { row: 1, col: 0, rowSpan: 1, colSpan: 2, rows: 2, cols: 6 },
    { row: 1, col: 2, rowSpan: 1, colSpan: 2, rows: 2, cols: 6 },
    { row: 1, col: 4, rowSpan: 1, colSpan: 2, rows: 2, cols: 6 },
  ],
  6: [ /* 3x2 */
    { row: 0, col: 0, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
    { row: 0, col: 1, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
    { row: 0, col: 2, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
    { row: 1, col: 0, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
    { row: 1, col: 1, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
    { row: 1, col: 2, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
  ],
};

export function computeTileRects(n: 1|2|3|4|5|6, width: number, height: number): TileRect[] {
  const pat = PATTERNS[n];
  const colW = Math.floor(width / pat[0].cols);
  const rowH = Math.floor(height / pat[0].rows);
  return pat.map(p => ({
    x: p.col * colW,
    y: p.row * rowH,
    w: p.colSpan * colW,
    h: p.rowSpan * rowH,
  }));
}
```

Edge cases:
- If `width < 2 * MIN_TILE_W` for an n>=2 layout, refuse to render the grid and surface a notice in the status line ("terminal too narrow for multi-view"). Suggest `MIN_TILE_W = 30`, `MIN_TILE_H = 8` — tune by feel.
- Round-down division leaves a few unused cells at the right/bottom edge. That's fine; the parent `<Box>` clips.

### Step 4: `MultiChatGrid` component

Create `apps/ade-cli/src/tuiClient/components/MultiChatGrid.tsx`:

```tsx
type Props = {
  tiles: MultiViewTile[];
  focusedIndex: number;
  width: number;
  height: number;
  eventsBySessionId: Record<string, AgentChatEventEnvelope[]>;
  sessionBySessionId: Record<string, AgentChatSessionSummary>;
  streamingBySessionId: Record<string, boolean>;
  scrollBySessionId: Record<string, number>;
  selectionBySessionId: Record<string, ChatTextSelection | null>;
  onFocusTile: (index: number) => void;
  onRemoveTile: (index: number) => void;
};

export function MultiChatGrid(props: Props) {
  const rects = useMemo(() =>
    computeTileRects(props.tiles.length as 1|2|3|4|5|6, props.width, props.height),
    [props.tiles.length, props.width, props.height]);

  return (
    <Box position="relative" width={props.width} height={props.height}>
      {props.tiles.map((t, i) => {
        const rect = rects[i];
        const isFocused = i === props.focusedIndex;
        return (
          <Box
            key={t.sessionId}
            position="absolute"
            marginLeft={rect.x}
            marginTop={rect.y}
            width={rect.w}
            height={rect.h}
          >
            <ChatView
              events={props.eventsBySessionId[t.sessionId] ?? []}
              activeSession={props.sessionBySessionId[t.sessionId]}
              streaming={!!props.streamingBySessionId[t.sessionId]}
              scrollOffsetRows={props.scrollBySessionId[t.sessionId] ?? 0}
              selection={props.selectionBySessionId[t.sessionId] ?? null}
              width={rect.w}
              maxRows={rect.h}
              focused={isFocused}
              onRemove={() => props.onRemoveTile(i)}
              // … other passthrough props
            />
          </Box>
        );
      })}
    </Box>
  );
}
```

Note: Ink supports `position="absolute"` via Yoga's positioning model; verify with a quick smoke test before relying on it. If it doesn't, render tiles in normal flow with computed line padding (the chat-row-budget pattern already does this).

### Step 5: Per-tile prompt history

```ts
// when submitting
setPromptHistoryBySessionId(prev => ({
  ...prev,
  [sessionId]: [...(prev[sessionId] ?? []).slice(-99), text],   // cap at 100
}));

// when up-arrow recalls
const history = promptHistoryBySessionId[focusedSessionId] ?? [];
```

### Step 6: Add-mode

State machine:
```
normal ──(Ctrl+A, only when activePane === "chat")──> addMode
addMode ──(Esc)──> normal (no changes)
addMode ──(Enter on highlighted chat)──> normal + multiView updated
```

Render: when `addMode` is set, the layout wraps every non-drawer region in a `<Box>` that applies dim styling (Ink's `<Text dimColor>` on all descendants, or a custom `<Dim>` wrapper). Insert a top banner row:
```
 Pick a chat to add  ·  ↵ Add  ·  Esc Cancel
```

The drawer renders normally but with a separate cursor state (`addMode.cursorLaneId / cursorChatId`) so navigation in add-mode does NOT touch `activeLaneId` / `activeSessionId`. Reuse the existing drawer rendering function — just thread the alternate cursor in.

Add behavior:
```ts
function addTileToGrid(sessionId: string, laneId: string) {
  setMultiView(prev => {
    // If chat is already in grid, refocus its tile, no-op the add.
    if (prev) {
      const existingIdx = prev.tiles.findIndex(t => t.sessionId === sessionId);
      if (existingIdx >= 0) return { ...prev, focusedIndex: existingIdx };
      if (prev.tiles.length >= 6) return prev;  // cap
      return {
        tiles: [...prev.tiles, { sessionId, laneId }],
        focusedIndex: prev.tiles.length,        // focus the newly added tile
      };
    }
    // Bootstrapping into multi-view: include the currently-active chat as tile 0
    return {
      tiles: [
        { sessionId: activeSessionIdRef.current, laneId: activeLaneIdRef.current },
        { sessionId, laneId },
      ],
      focusedIndex: 1,
    };
  });
}
```

### Step 7: Remove

```ts
function removeTile(index: number) {
  setMultiView(prev => {
    if (!prev) return prev;
    const tiles = prev.tiles.filter((_, i) => i !== index);
    if (tiles.length < 2) {
      // Exit multi-view; surviving tile (if any) becomes the active chat in single mode
      if (tiles[0]) {
        selectActiveLaneId(tiles[0].laneId);
        selectActiveSessionId(tiles[0].sessionId);
      }
      return null;
    }
    const focusedIndex = Math.min(prev.focusedIndex, tiles.length - 1);
    return { tiles, focusedIndex };
  });
}
```

### Step 8: Focus follows tile

When `multiView` is set and `multiView.focusedIndex` changes, sync the rest of the TUI:
```ts
useEffect(() => {
  if (!multiView) return;
  const tile = multiView.tiles[multiView.focusedIndex];
  if (!tile) return;
  if (tile.laneId !== activeLaneIdRef.current) selectActiveLaneId(tile.laneId);
  if (tile.sessionId !== activeSessionIdRef.current) selectActiveSessionId(tile.sessionId);
}, [multiView]);
```

This makes the right pane, status bar, and sidebar lane highlight all reflect the focused tile's lane automatically — they already read from `activeLaneId` / `activeSessionId`.

### Step 9: Drag-to-add

In the drawer chat row component, register a `onDragStart` via the registry (extend `HitTarget` with optional `onDragStart`/`onDrop`). When mouse-drag begins on a chat row and ends inside the middle pane bounds, invoke `addTileToGrid(sessionId, laneId)`. Mouse mode 1002 (drag) is already enabled — coordinates flow through the parser as `drag` events.

### Step 10: Keybindings

Pick free chords. Suggested:
- `Ctrl+G` — toggle add-mode (only fires when `activePane === "chat"`)
- `Ctrl+W` — remove focused tile
- `Tab` — cycle focused tile within multi-view (existing `Tab` cycles panes; bind it to tile-cycle when in chat pane *and* multi-view is active; otherwise current behavior)
- Mouse: click anywhere inside a tile = focus that tile; click on the `×` = remove

Document these in the footer and in `FooterControls` rendering.

---

## UI specification (depth)

### Tile chrome

Single-line header at the top of each tile:

```
┌ lane-slug / chat-title ●─────────────── ×┐
```

- Leading `┌` corner from Ink's border.
- `lane-slug` truncated with ellipsis if needed to keep `chat-title` visible.
- ` / ` separator.
- `chat-title` (the session's display name) truncated as needed.
- Trailing space + `●` when `streaming === true`, otherwise space.
- Right-aligned `×` (1 cell) when `onRemove` is provided. Register this single cell as a separate hit target so click works precisely.

### Focused tile vs unfocused

- **Unfocused tile**: `borderStyle="round"` (Ink built-in), header text default color.
- **Focused tile**: `borderStyle="double"`, header text in cyan (`<Text color="cyan">…</Text>`).
- Content (message body) is **not dimmed** on unfocused tiles — keep them fully readable so background streaming is visible at a glance.

### Six grid layouts (wireframes)

Imagine the middle pane is ~80 cols wide × ~24 rows tall. Borders are illustrative; real rendering uses Ink's box borders.

**N=1 — full:**
```
┌─ lane-a / chat-1 ●────────────────────────────────────────────────────────┐
│                                                                            │
│ (full chat body)                                                           │
│                                                                            │
└────────────────────────────────────────────────────────────────────────── ×┘
```

**N=2 — 2 cols:**
```
┌─ lane-a/chat-1 ●─────────────┐ ╔ lane-b/chat-2 ●═════════════════╗
│                              │ ║                                  ║
│ left chat                    │ ║ right chat (focused)            ║
│                              │ ║                                  ║
└──────────────────────────── ×┘ ╚══════════════════════════════ ×╝
```

**N=3 — 3 cols:**
```
┌ lane-a/c1 ●────┐ ┌ lane-b/c2 ●────┐ ╔ lane-c/c3 ●════════╗
│                │ │                │ ║                     ║
│                │ │                │ ║ focused            ║
└────────────── ×┘ └────────────── ×┘ ╚════════════════ ×╝
```

**N=4 — 2×2:**
```
┌ lane-a/c1 ●────────────────┐ ╔ lane-b/c2 ●═══════════════╗
│                            │ ║ (focused)                  ║
└────────────────────────── ×┘ ╚═════════════════════════ ×╝
┌ lane-c/c3 ●────────────────┐ ┌ lane-a/c4 ●────────────────┐
│                            │ │                            │
└────────────────────────── ×┘ └────────────────────────── ×┘
```

**N=5 — 2 top + 3 bottom:**
```
┌ lane-a/c1 ●────────────────────────┐ ┌ lane-b/c2 ●───────────────────────┐
│                                    │ │                                   │
│                                    │ │                                   │
└────────────────────────────────── ×┘ └─────────────────────────────────×┘
┌ lane-c/c3 ●──────┐ ╔ lane-d/c4 ●═════╗ ┌ lane-e/c5 ●──────┐
│                  │ ║ (focused)        ║ │                  │
└──────────────── ×┘ ╚═══════════════ ×╝ └──────────────── ×┘
```

**N=6 — 3×2:**
```
┌ lane-a/c1 ●─────┐ ┌ lane-b/c2 ●─────┐ ╔ lane-c/c3 ●═══════╗
│                 │ │                 │ ║ focused           ║
└─────────────── ×┘ └─────────────── ×┘ ╚═══════════════ ×╝
┌ lane-d/c4 ●─────┐ ┌ lane-e/c5 ●─────┐ ┌ lane-f/c6 ●───────┐
│                 │ │                 │ │                   │
└─────────────── ×┘ └─────────────── ×┘ └───────────────── ×┘
```

### Add-mode

Full app view with dim overlay everywhere except the drawer:

```
 Pick a chat to add  ·  ↵ Add  ·  Esc Cancel
┌──────────────┐ ┌── (dim middle) ─────────────┐ ┌(dim right)┐
│ lane-foo     │ │ existing tile contents      │ │           │
│   chat-1 ▸   │ │ (still visible, just dim)   │ │           │
│   chat-2     │ │                             │ │           │
│ lane-bar     │ │                             │ │           │
│   chat-3     │ │                             │ │           │
│   chat-4     │ └─────────────────────────────┘ └───────────┘
│ lane-baz     │ ┌── (dim prompt) ──────────────────────────┐
│   chat-5     │ │                                          │
└──────────────┘ └──────────────────────────────────────────┘
```

- Banner uses default colors (not dimmed) — it's the only bright thing besides the sidebar so the eye lands on it.
- The `▸` marker indicates the add-mode cursor (separate from the underlying active-chat highlight).
- Pressing arrow keys moves `▸` across lanes and chats freely. `Enter` adds. `Esc` exits.

### Status-bar grid mini-map

Append to the footer status row, after model name:

- N=1: `▣`
- N=2: `▣▢` or `▢▣` depending on focus
- N=3: `▣▢▢` etc.
- N=4: `▣▢ / ▢▢` (rows separated by ` / `)
- N=5: `▣▢ / ▢▢▢`
- N=6: `▣▢▢ / ▢▢▢`

Use `▣` for focused tile, `▢` for unfocused. Render in plain Unicode; no color needed.

### Hover affordance (universal click)

When `hoveredId` matches a registered target, the target renders with a subtle highlight. Pick **one** of these and apply consistently:

- Option A: `<Box backgroundColor="blackBright">` wrapping the target.
- Option B: `<Text inverse>` on the target's text.

Recommendation: Option A for multi-cell targets (rows, buttons, tabs), Option B for inline single-line affordances (the `×`, palette items). Keep the effect very subtle — this is a confirmation, not a beacon.

---

## Edge cases to handle

- **Terminal too narrow** for the chosen grid (e.g. N=6 but `width < 90`). Refuse to render the grid; show a notice in the status line ("Multi-view: terminal too narrow, displaying focused tile only") and render only the focused tile full-width until the terminal grows.
- **Tile session ends** (chat marked `status: "ended"`). Keep the tile visible (with greyed header), don't auto-remove. Let the user decide via `×`.
- **Lane deleted** while one of its sessions is in the grid. Treat similarly to ended — keep the tile, badge it with `(lane removed)` in the header.
- **Drag-to-add when grid is already at 6**: ignore the drop, flash a 1s status-line notice ("Multi-view full (max 6)").
- **Active session changes** outside multi-view (e.g. user clicks a sidebar chat in single-chat mode). Single-chat behavior preserved exactly.
- **Add-mode while terminal resizes**: cancel add-mode, return to normal layout, do not lose existing multi-view tiles.
- **Mouse mode 1003 not supported** by the user's terminal (rare but possible — older `tmux` versions, some SSH client wrappers). Detection is hard; if hover events never arrive, the feature degrades gracefully — clicks still work, just no hover. Acceptable.
- **High event volume** with 6 concurrent streams: confirm event aggregation in `aggregateChatBlocks` doesn't lock the render thread. Add a small throttle if needed (coalesce per-session re-renders to ~30 Hz).

---

## Files to create / modify

### Create

- `apps/ade-cli/src/tuiClient/hitTestRegistry.ts` — registry implementation + React context + `useHitTest` hook.
- `apps/ade-cli/src/tuiClient/multiChatLayout.ts` — `computeTileRects` + PATTERNS table.
- `apps/ade-cli/src/tuiClient/components/MultiChatGrid.tsx` — grid wrapper rendering N `<ChatView>` instances.
- `apps/ade-cli/src/tuiClient/components/AddChatMode.tsx` — banner + dim wrapper + alt-cursor drawer rendering.
- `apps/ade-cli/src/tuiClient/components/GridMiniMap.tsx` — small footer component.
- Test files alongside each.

### Modify

- `apps/ade-cli/src/tuiClient/app.tsx` — the bulk of the work:
  - Add new state (multiView, addMode, streamingBySessionId, scrollBySessionId, selectionBySessionId, promptHistoryBySessionId).
  - Replace `streaming` references throughout.
  - Widen `onChatEvent` filter to `openSessionIds`.
  - Branch middle-pane render: `multiView ? <MultiChatGrid …/> : <ChatView …/>`.
  - Extend `useInput` to handle add-mode keys (Esc, Enter, arrows) and multi-view keys (Ctrl+G, Ctrl+W, Tab for tile cycle).
  - Update `submitPrompt` to route by focused tile.
  - Enable/disable mouse mode 1003.
  - Migrate each existing `*IndexForMouseLine` helper to component-level registry registration.
  - Add `useEffect` syncing focused-tile → active lane/session.
- `apps/ade-cli/src/tuiClient/components/ChatView.tsx` — add `focused?: boolean` + `onRemove?: () => void` props; render double-border + cyan header + clickable `×` accordingly.
- `apps/ade-cli/src/tuiClient/state.ts` — **no changes** (multiView intentionally ephemeral).

---

## Verification plan

End-to-end (run the TUI in this worktree):

1. **Universal click smoke test**
   - Open model picker → click rows, tabs, favorite star → confirm parity with keyboard.
   - Trigger approval prompt → click accept/decline.
   - Open slash and mention palettes → click items.
   - Open lane-delete form → click radio options and force toggle.
   - Move mouse around → hover-highlight follows pointer.

2. **Multi-chat lifecycle**
   - From single chat, press `Ctrl+G` → add-mode banner appears, non-sidebar regions dim.
   - Arrow into another lane → confirm underlying active lane stays put.
   - Press Enter on a chat → grid switches to 2-col with new tile focused, right pane updates to new tile's lane.
   - Add 3rd, 4th, 5th, 6th → confirm layouts match wireframes.
   - Press `Ctrl+G` while 6 tiles open and try to add → confirm cap (no add, notice).
   - Click `×` on a tile → confirm removal + grid reshapes.
   - Remove down to 2 tiles → confirm remaining tile becomes single-chat mode (multiView cleared).

3. **Cross-lane focus sync**
   - 2 tiles from 2 lanes → click between them → confirm right pane, status bar, sidebar lane highlight all follow focused tile.
   - Switch lanes via sidebar → confirm multi-view persists.

4. **Concurrent streaming**
   - Open 3 tiles → send a long prompt in each (focus, submit, focus next, submit, focus next, submit).
   - Confirm all three stream simultaneously with ● indicators; non-focused tiles continue rendering events.

5. **Per-tile history**
   - Send 3 prompts to tile A, 2 prompts to tile B.
   - Focus A → up-arrow cycles only A's. Focus B → up-arrow cycles only B's.

6. **Drag-to-add**
   - Click-drag a sidebar chat row into the middle → confirm it adds without add-mode.

7. **Persistence (negative)**
   - Open 4 tiles → kill TUI → relaunch → confirm app starts in single-chat mode.

Unit tests:

- `hitTestRegistry.test.ts` — register/unregister, overlapping rects (higher `zIndex` wins), out-of-bounds returns null.
- `multiChatLayout.test.ts` — for each n ∈ [1,6], rects tile the area without overlap, respect minimums, total area ≤ input area.
- `streamingBySessionId.test.ts` — events for non-focused sessions still update the per-session record.
- `addMode.test.ts` — keyboard navigation does not mutate `activeSessionId` / `activeLaneId`; Enter calls `addTileToGrid` with the cursor target.

Manual perf: with 6 tiles streaming, keystroke latency in the bottom prompt stays under ~16ms.

---

## Docs / references to read before starting

- **Ink (terminal React)**: <https://github.com/vadimdemedes/ink#readme> — especially the section on `Box`, `Text`, `useInput`, `useStdout`, and the `position`/`marginLeft`/`marginTop` props (Yoga layout).
- **XTerm mouse tracking modes**: <https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Mouse-Tracking> — for mode 1003 (any-event tracking), SGR encoding, and how to disable cleanly.
- **Yoga layout reference**: <https://yogalayout.dev/> — Ink's underlying layout engine; relevant if you opt for `position="absolute"` in `MultiChatGrid`.
- **Existing ADE patterns to study before coding**:
  - `apps/ade-cli/src/tuiClient/app.tsx` — read `parseTerminalMouseInput`, `submitPrompt`, `onChatEvent`, the `useInput` block, and the layout `<Box>` tree (~7626–7800).
  - `apps/ade-cli/src/tuiClient/components/ChatView.tsx` — full component, especially the event-aggregation and row-rendering paths.
  - `apps/ade-cli/src/tuiClient/state.ts` — to know what NOT to touch for persistence.
  - `apps/desktop/src/shared/types/chat.ts` lines 725–773 — the `AgentChatSession` type and friends.
- **Existing hit-test helpers** (to be deleted post-migration): `laneDetailsActionIndexForMouseLine`, `formFieldIndexForMouseLine`, `setupPaneRowIndexForMouseLine`, `subagentIndexForPaneLine` in `app.tsx` ~1557–1620.

---

## Out of scope (do not do)

- **Persistence of multi-view across restart** — explicitly ephemeral.
- **Broadcasting one prompt to multiple tiles** — single-tile routing only.
- **Per-tile prompt input** — keep the one bottom prompt; routing changes are enough.
- **Tile rearranging / drag-to-swap** — tiles render in insertion order; not negotiable for v1.
- **Number-key tile focus, middle-click remove, hover gutter arrow, streaming flash on non-focused tile** — not selected from the extras menu.
- **Touching the desktop or web apps** — TUI-only change.
