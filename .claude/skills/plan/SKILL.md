---
name: plan
description: Deliberate a feature or change in three locked rounds — functional requirements, then UI design with wireframes, then extras/quirks/out-of-the-box ideas. Each round asks the user clarifying questions via AskUserQuestion before proceeding. New functional scope at any point cascade-restarts the new piece through all three rounds and merges it into the locked plan. Use when the user invokes `/plan`, when the user is in plan mode and asks for a design/spec/feature breakdown, or when a non-trivial change needs structured deliberation before implementation.
metadata:
  author: ade
  version: "1.0"
---

# /plan — Three-Round Locked Deliberation

A feature plan has three layers: **what it does**, **how it looks**, and **the delightful extras**. Cross-talk between them produces sloppy plans. This skill enforces a strict order: lock functional, then lock UI, then add extras. New functional scope discovered at any point cascades back through all three rounds *for that new piece only*, then merges into the locked plan.

## Activation

Activate when **any** of:
- The user invokes `/plan` (with or without extra context).
- The user is in plan mode and asks for a design, spec, breakdown, or feature plan.
- A non-trivial change request would benefit from structured deliberation (multi-component features, UX-sensitive work, anything spanning >2 files).

## Pre-flight: plan mode gate

Before Round 1, verify plan mode is active. If not:

> This skill is meant to run in plan mode (read-only deliberation). Enter plan mode (Shift+Tab cycles to it) and re-invoke `/plan <your context>`.

Then stop. Do not proceed in edit/full-auto modes — the deliberation contract assumes no files will be touched mid-plan.

## State you must track

Maintain these in your head (or in scratch) across the whole skill:

- **LockedFunctional** — bullet list of functional requirements confirmed so far.
- **LockedUI** — bullet list of UI decisions confirmed so far (with wireframe sketches).
- **LockedExtras** — list of delightful extras confirmed.
- **CurrentRound** — 1 (Functional), 2 (UI), or 3 (Extras).
- **PendingNewPieces** — queue of new functional requirements detected mid-flight that need their own cascade.

When a cascade fires, you snapshot CurrentRound, run the cascade for the new piece, merge results back into the Locked* sets, then resume from the snapshotted round.

## Round 1 — Functional Requirements

Silently deliberate on what the user asked for. Pull out:
- Core capabilities the feature must have.
- Boundaries (what it does *not* do).
- Inputs, outputs, edge cases that change behavior.
- Ambiguities where multiple interpretations exist.

Then call **AskUserQuestion** with 1–4 questions that resolve the meaningful ambiguities. Each option should describe a concrete interpretation with its trade-off. Avoid asking the user to write prose — frame everything as concrete choices.

### Tool reference: AskUserQuestion

Use `AskUserQuestion(questions)` to gather structured choices during Round 1, Round 2, Round 3, and any cascade. `questions` is an array of question objects:

- `id`: stable snake_case identifier.
- `title`: short user-facing label.
- `text`: the actual question.
- `multiSelect`: optional boolean for menus like LockedExtras.
- `allowOther`: optional boolean that permits an "Other" selection.
- `allowAnnotation`: optional boolean that permits free-text annotation alongside a selected option.
- `options`: array of `{ id, label, tradeoffs, description?, preview? }`.

The return value is keyed by question id and contains `selectedOptionIds`, optional `otherText`, and optional `annotations` / `freeText`. Treat selected option ids as the locked choice. Treat `otherText` as a new option authored by the user; if it changes behavior, update **LockedFunctional** and trigger the **Cascade rule**. Treat annotations as refinements to the selected option; if an annotation adds behavior rather than clarifying wording or presentation, it also cascades.

When the user responds:
- Treat selected options as additions to **LockedFunctional**.
- If the user's free-text (the "Other" reply or annotation) adds new scope → see **Cascade rule** below.
- If the user only clarifies an existing item → update **LockedFunctional** and proceed.

Once questions are answered, **do not ask for explicit confirmation**. Silently move to Round 2.

## Round 2 — UI Design

Now deliberate on how the feature presents to the user. Generate 1–3 candidate UI directions. Round 2 candidates may be full-layout wireframes when the whole surface is up for decision, or component-level candidates when only one area is ambiguous. Be explicit which level each candidate represents.

Call **AskUserQuestion** with options that carry **markdown wireframe previews** in the `preview` field. Wireframes are ASCII boxes:

```
┌─────────────────────────────────┐
│  Header  ·  filter ▾  ·  +new   │
├─────────────────────────────────┤
│ ▣ item                     ⋯    │
│ ▢ item                     ⋯    │
│ ▢ item                     ⋯    │
└─────────────────────────────────┘
```

Keep each preview readable in a chat-width column (~70 chars). Show real labels, real density, real affordances — not lorem ipsum.

Cover the meaningful axes (layout type, hierarchy of actions, empty/loading/error states, dense vs roomy) in **at most 4 questions total**. Don't waste a question on a decision that has one obvious answer.

When the user responds:
- Selected wireframes/options → **LockedUI**.
- If candidates were component-level, merge the selected components into **LockedUI** as integration decisions. The Final output still needs one composed/merged inline wireframe derived from **LockedFunctional**, **LockedUI**, and any selected **LockedExtras**.
- Free-text that implies new functional behavior (e.g. "add export button" implies an export *flow*) → see **Cascade rule**.
- Pure UI refinements stay in Round 2.

Silently proceed to Round 3.

## Round 3 — Extras, Quirks, Out-of-the-Box

Now generate 4–8 candidate ideas the user *didn't* ask for but might love: micro-interactions, keyboard shortcuts, empty-state delight, power-user features, animations, accessibility wins, surprise affordances, anti-aesthetics-of-AI touches (favor warmth and specificity over generic monochrome polish).

Call **AskUserQuestion** with `multiSelect: true` for the menu of extras. Each option's `description` should be one sentence explaining the idea and one sentence on the cost/benefit.

Selected items → **LockedExtras**.

If the user adds a new functional idea in free-text → **Cascade rule**.

## Cascade rule (the core contract)

A **new functional requirement** is any input — from the user OR self-detected from your own proposals — that adds, removes, or changes scope of the feature. Not a UI refinement. Not an extras pick. *New behavior the system must perform.*

When detected:

1. **Snapshot** the current round.
2. **Queue** the new piece in **PendingNewPieces** with a one-line description.
3. **Announce briefly**: "New functional piece detected: <X>. Cascading it through R1→R2→R3 before resuming Round <snapshot>."
4. **Run a focused mini-cascade for that piece only**:
   - **R1 for new piece**: AskUserQuestion scoped to just the new piece's functional ambiguities.
   - **R2 for new piece**: AskUserQuestion with wireframes scoped to just how this new piece integrates into the already-locked UI (do NOT redesign locked layouts — show how the new piece slots in).
   - **R3 for new piece**: AskUserQuestion with extras *for this piece only*.
5. **Merge** the results into the appropriate Locked* sets.
6. **Resume** from the snapshotted round.

Multiple cascades may stack. Process them depth-first; never lose the snapshot.

### Self-detecting new functional scope

Before sending a UI option or an extra, ask yourself silently: *does this option require behavior that isn't already in LockedFunctional?* If yes, you have a choice:
- Drop the option (cleanest).
- Or, if it's genuinely a great idea, **fire the cascade yourself** before sending it. Don't sneak new functional scope into UI/extras questions.

## Final output

After Round 3 completes with no pending cascades:

1. Print a tight consolidated plan in chat with three sections:
   - **Functional** — bulleted LockedFunctional.
   - **UI** — bulleted LockedUI with one inline wireframe of the final composed layout.
   - **Extras** — bulleted LockedExtras.
   Keep total under ~50 lines. No filler.
2. Call **ExitPlanMode** to formally request approval.

### Tool reference: ExitPlanMode

Use `ExitPlanMode(): void` immediately after the Final output. It has no parameters and returns no value. Calling it signals that **LockedFunctional**, **LockedUI**, and **LockedExtras** are complete, including the final composed wireframe, and asks the user to approve leaving plan mode. Do not call it before all pending cascades are processed.

## Anti-patterns (do not do)

- Asking the user to "describe what they want" in prose. Always frame as concrete options.
- Sending more than 4 questions in a single AskUserQuestion call (tool max).
- Slipping new functional behavior into UI or Extras rounds without cascading.
- Asking explicit "lock in? yes/no" questions between rounds — proceed silently unless interrupted.
- Re-litigating LockedFunctional during R2 or R3 unless a cascade explicitly opens that piece.
- Generic AI aesthetics in wireframes — no `font-mono` aesthetic apologies, no centered-everything, no purple gradients in mocked copy. Be specific and warm.
- Long preamble. The user invoked `/plan`; jump to Round 1.

## Minimal example flow

User: `/plan a markdown note app with tags`

You: silent deliberation → AskUserQuestion (R1):
- Q1: "How should tags be created?" (inline `#tag` parsing / explicit tag field / both)
- Q2: "Search scope when filtering by tag?" (notes containing tag / notes tagged-only / both modes)
- Q3: "Multi-user or single-user?"

User selects + adds "and they sync to iCloud" (new functional scope).

You: "New piece detected: iCloud sync. Cascading."
→ R1-for-sync: conflict resolution? offline-first?
→ R2-for-sync: sync-status indicator placement?
→ R3-for-sync: optimistic UI? merge-conflict modal?
Merge → resume Round 1.

… and so on through R2 and R3 of the main plan, then ExitPlanMode.
