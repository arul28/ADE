# Ask-question surface — implementation spec

**Status:** design locked, not implemented.
**Visual reference:** `docs/design/ask-question-redesign.html` — open it in a browser.
It is live React and the option rows, previews, minimize, and Send labels all work.
Rendered stills are in `docs/design/renders/`.

This document is the contract. Where it and the HTML disagree, **this document wins**
for behavior and the HTML wins for visuals.

---

## 1 · The problem

`PendingInputRequest` (`apps/desktop/src/shared/types/chat.ts`) is one data model with
four independent renderers that disagree about what an answer *is*:

| Surface | File | Selection + typed text |
|---|---|---|
| Desktop | `AgentChatMessageList.tsx:2632` `InlineQuestionRequestCard` | **both sent**, as an array |
| Web client | *same React component* | same |
| TUI | `tuiClient/pendingInput.ts` `buildPendingInputAnswers` | **either/or** — text *replaces* the selection |
| iOS | `WorkChatComposerAndInputViews.swift:969` `WorkStructuredQuestionCard` | 1 question: both · N questions: **note silently dropped** |

No provider forces any of this. Verified end to end:

- **Claude** (`v2Client.question.reply`) takes `answers: string[][]` — an array *per question*.
- **Codex / Cursor / OpenCode** go through ADE's own `askUser` tool
  (`universalTools.ts:2619`), which returns free-form JSON
  `{answer, answers, responseText, decision}`. No constraint at all.
- **Droid** (`onAskUserRequest`) takes a single `answer: string`; ADE currently flattens
  with `.join(", ")`.

The divergence is entirely ours.

Secondary defects fixed here:

- **Duplicate surface.** `AgentChatComposer.tsx:4130` renders a second "CLAUDE ASKS"
  block for question kinds whose entire content is a hint string plus a Decline
  button — while `composerInputLocked` (line 1808) has already hard-locked the
  textarea. The composer is dead *and* wearing a sign saying so.
- **Hidden mode switch.** `handleOption` (line 2718) submits immediately on click for a
  single single-select question — *unless* the freeform field has text, in which case
  it only selects. Same click, two outcomes, no signal.
- **Hover-reflow jitter.** Options set `onMouseEnter → setFocusedOption`
  (line 2863) and the focused option's preview renders below the list at its natural
  height. Hover → preview swap → card height change → virtualizer re-measure →
  `reconcileMeasuredScrollTop` → the card shifts under the cursor → the cursor is now
  over a different option → repeat. The row runs away from the click.

---

## 2 · Answer semantics (the shared contract)

Lives in `apps/desktop/src/shared/pendingInputAnswers.ts`. The TUI imports it directly
(it already imports `pendingInputLabels` and `types/attention` from
`apps/desktop/src/shared/`). **iOS mirrors it in Swift** — it cannot import TypeScript;
`workChatPendingInputHeaderVerb` in `WorkModels.swift` is the existing precedent.

### Four states, per question

```
EMPTY      nothing picked, no note   → Send disabled
PICK       option(s) picked          → "Send 1"  ·  "Send 3 picks"
PICK_NOTE  option(s) + note          → "Send 1 + note"  ·  "Send 3 + note"
NOTE       note only, no pick        → "Send note"
```

Rules, all four surfaces:

1. **Both travel.** A note never replaces a selection; a selection never clears a note.
2. **Typing never deselects. Selecting never clears the note.**
3. **Selection values come first**, note last, so a model reads the choice before the
   qualification.
4. **The Send label is the payload receipt.** It is derived from the state and nothing
   else. If the label and the payload can disagree, the implementation is wrong.
5. **Multi-question:** Send is enabled only when every question is answered; the label
   becomes `Send N answers`.

### Reference implementation

Ported verbatim from the HTML (`answerState`, `sendLabel`, `buildAnswers`,
`notePlaceholder`, `foldedSummary`). Signatures:

```ts
type AnswerState = "EMPTY" | "PICK" | "PICK_NOTE" | "NOTE";

function answerState(picks: string[], note: string): AnswerState;

function sendLabel(args: {
  picks: string[]; note: string; isLast: boolean;
  totalAnswered: number; totalQuestions: number;
}): string;

function buildAnswers(
  questions: PendingInputQuestion[],
  picksById: Record<string, string[]>,
  notesById: Record<string, string>,
): Record<string, string | string[]>;

function notePlaceholder(args: {
  hasOptions: boolean; picks: string[]; multi: boolean;
}): string;
```

### Note-row placeholder — state-dependent

The field has two jobs and the placeholder says which one is live:

| condition | placeholder |
|---|---|
| question has no options | `Your answer` |
| options exist, nothing picked | `Or send your own response instead` |
| exactly one pick | `Add a note (sent with your pick)` |
| N > 1 picks (multi-select) | `Add a note (sent with your N picks)` |

No disabled state, no mode switch.

### Sites to fix

- `tuiClient/pendingInput.ts` `buildPendingInputAnswers` — currently text-replaces-selection.
  Must accumulate.
- `WorkStructuredQuestionCard.submitAll` — the `continue` after a non-empty selection
  drops the per-question freeform. Must append it.
- `agentChatService.ts` Droid `onAskUserRequest` — replace `.join(", ")` with a
  labelled join so the note is distinguishable from a choice.
- Delete `handleOption`'s `submitSingle` branch entirely.

---

## 3 · Interaction

- **The card is the composer.** While a question blocks, the question card replaces the
  textarea inside the same prompt-box frame — same border, radius, and width — so
  nothing shifts when it resolves. Delete the question-kind `pendingBanner`.
  `plan_approval`, `model_selection`, `approval`, and `permissions` keep theirs; they
  render real controls.
- **The model / permission / effort row is hidden while asking.** It returns on send.
- **Select marks; it does not advance.** `Next` / `Enter` advances. The note field stays
  reachable the whole time.
- **Multi-question:** one question at a time, with a dot rail in the header (filled =
  current, green = answered) to jump back. `N / M` in the footer.
- **Previews open on an explicit disclosure click only.** The click neither selects the
  option nor advances the question.
- **Hover mutates no state.** Preview follows keyboard focus and explicit clicks only.
  This is half the jitter fix; the other half is the fixed-height preview viewport.
- **Compare** stays: a fixed-height 2-up split when ≥2 options carry previews.
- **Keyboard:** `1-9` pick, `↵` next/send, `←→` page, `esc` decline. Already mostly
  present on desktop and in the TUI; keep and make consistent.

### Height budget — the card never outgrows the chat

Only the option list scrolls. Header, note row, and footer are pinned outside the
scroll region, so Decline / Next / Send are reachable at any list length.

iOS already proves this shape (`topChrome` / `ScrollView` / `bottomChrome` in
`WorkStructuredQuestionCard`). **Budget from the chat surface, never from the transcript
viewport** — the existing comment on `workPendingInputMaxHeight` explains why: the
transcript shrinks as the card grows, so feeding its height back in creates a runaway
loop that eats the screen. Desktop and the TUI adopt the same rule.

When rows fall fully below the fold, a `⌄ N more options` row renders on its own line
between the list and the note row. It scrolls the list on click. **On its own line
specifically** so it can never cover a row the user meant to click. A shadow alone was
tested and is not enough — an 8-option list that cuts cleanly after 4 reads as "there
are four options".

### Minimize

A `⌄` control sits beside the `×` in the header. It folds the card to a single line
inside the prompt box so the transcript can be scrolled freely.

- It does **not** dismiss and does **not** unblock. The gate stays open.
- The folded line shows: provider mark · `{header} — {question}` (ellipsised) ·
  answered count (`0/2`) or `ANSWER` for a single question · `⌃`.
- `×` remains the decline. These are two different affordances and must not be merged.
- iOS already has this concept as `pendingInputCollapsed`; desktop adopts it and both
  share the summary string.

Measured on a 390×844 phone: minimizing returns the transcript from 276px to 699px.

---

## 4 · Visual

Full detail in the HTML. The rules:

- **Ledger rows.** Hairline between options. No per-option border, fill, radius, or
  radio glyph. One column always — never a 2-col grid (3 options in 2 columns leaves a
  ragged orphan).
- **Selection = `✓` flush-right.** The leading number stays constant.
- **Uppercase mono option labels are kept** — it is a developer tool and that voice is
  deliberate — but the tint count drops from ~9 to **2**: the header mark and the
  selected `✓`. Provider accent comes from `--chat-accent`
  (`chatSurfaceTheme.ts`), so Codex/Cursor/Droid theming is automatic.
- **Four type levels:** header 10px mono accent · question 15px sans · option label
  12px mono · description 12px sans at 55%.
- The one structural use of accent is a hairline top border on the composer meaning
  "you are in answer mode". Not a glow, not a fill.

### Answered receipt

Built from `chatCardPrimitives` on the `AdeCard` convention, so it aligns
column-for-column with every other transcript row. Per that file's own rule — *"a quiet
result is ONE line, no box, hairline rule"* — the resolved state is a single expandable
line. Expanding shows every option that was offered with the chosen one marked, plus the
note. A declined request records as declined rather than vanishing.

---

## 5 · Scope split

Two PRs, **not stacked**. Desktop/TUI and iOS are siblings, not a chain — stacking would
impose a false dependency and force rebases over changes neither reads.

**PR 1 — contract + desktop + web + TUI.** One language, one CI, one release train. The
shared module ships with two real consumers, so its API is reviewable. Web client is free
(same React component).

**PR 2 — iOS.** Swift, Xcode CI, TestFlight — a separate release train that
`/release` already detects independently.

There is **no correctness window** between them: the surfaces are independently local
with no wire incompatibility, so temporary drift is cosmetic. (This would not hold if
cross-device draft sync were in scope. It is not.)

If the iOS adoption lands under ~150 lines with no SwiftUI layout rework, fold it into
PR 1 instead of opening PR 2.

---

## 6 · Out of scope

Considered and explicitly dropped — do not add them:

- Cross-device draft sync (would introduce real shared state and a correctness window).
- Send → undo window / deferred dispatch.
- Preselecting the recommended option.
- Storing the offered options on the resolved event for the receipt.
- A richer decline message to the model.

Kept: **Compare** (§3) and **question-arrival attention** — session row badge,
attention-center entry, iOS push, consistent for question kinds.

---

## 7 · Verification

- Behavior parity across surfaces is the point; a test that passes on one surface and
  has no counterpart on another has not covered the bug class this fixes.
- Table-driven tests over the four answer states for `sendLabel`, `buildAnswers`, and
  `notePlaceholder`, mirrored in Swift.
- Regression test for the hidden mode switch: clicking an option with a non-empty note
  must select, not submit.
- Regression test for hover: `mouseEnter` on an option must not change the preview or
  any state.
- Existing question-path tests live in `AgentChatMessageList.test.tsx` (12 sites),
  `AgentChatComposer.test.tsx` (14), `ApprovalPrompt.test.tsx` (4),
  `pendingInput.test.ts` (3), and `ADETests.swift` (45). Update, don't delete.
