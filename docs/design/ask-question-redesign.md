# Ask-question surface: contract

**Status:** built on desktop and the web client
(`apps/desktop/src/renderer/components/chat/AskQuestionComposer.tsx`,
`QuestionReceipts.tsx`; see the chat feature doc). iOS sends both a pick and a
note (`WorkQuestionAnswerBuilder` in `apps/ios/ADE/Views/Work/WorkModels.swift`)
but does not yet use the shared Send labels and note placeholders below.

**Visual reference:** `docs/design/ask-question-redesign.html` (live React; open
it in a browser). Stills are in `docs/design/renders/`. Where this document and
the HTML disagree, this document wins for behavior and the HTML for visuals.

## Answer semantics (shared contract)

Lives in `apps/desktop/src/shared/pendingInputAnswers.ts` (`answerState`,
`sendLabel`, `buildAnswers`, `notePlaceholder`, `foldedSummary`,
`sanitizeAnswersForTranscript`). iOS mirrors it in Swift, since it cannot
import TypeScript.

Four states per question:

```
EMPTY      nothing picked, no note   -> Send disabled
PICK       option(s) picked          -> "Send 1"  /  "Send 3 picks"
PICK_NOTE  option(s) + note          -> "Send 1 + note"  /  "Send 3 + note"
NOTE       note only, no pick        -> "Send note"
```

Rules on every surface:

1. **Both travel.** A note never replaces a selection; a selection never
   clears a note. Typing never deselects.
2. **Selection values come first**, the note last.
3. **The Send label is the payload receipt.** It comes from the state and
   nothing else.
4. **Several questions:** Send is enabled only when every question is
   answered; the label is `Send N answers`.
5. **Selecting never submits.** `Next` / `Enter` advances.

Note placeholder by state:

| Condition | Placeholder |
|---|---|
| question has no options | `Your answer` |
| options exist, nothing picked | `Or send your own response instead` |
| exactly one pick | `Add a note (sent with your pick)` |
| N > 1 picks | `Add a note (sent with your N picks)` |

Providers that take one string (Droid's `onAskUserRequest`) get a labelled
join (`flattenAnswerForSingleStringProvider`), so the note stays distinct from
a choice.

## Interaction

- **The card is the composer.** While a question blocks, the card replaces the
  textarea inside the same prompt-box frame, so nothing shifts when it
  resolves. The model / permission / effort row hides while asking.
  `plan_approval`, `model_selection`, `approval` and `permissions` keep their
  own controls.
- **Several questions:** one at a time, a dot rail in the header to jump back,
  `N / M` in the footer.
- **Hover changes no state.** A preview opens only on an explicit disclosure
  click (not on keyboard focus), which neither selects nor advances. Focus
  moves the ring and nothing else; otherwise the card's height changes under
  the cursor and the row runs away from the click.
- **Compare:** a fixed-height two-up split when two or more options carry
  previews.
- **Keys:** `1-9` pick, Enter next/send, Left/Right page, Esc decline.
- **Height budget:** only the option list scrolls; header, note row and footer
  stay pinned. Budget from the chat surface, never from the transcript
  viewport (the transcript shrinks as the card grows, a runaway loop; see
  `workPendingInputMaxHeight` on iOS). When rows fall below the fold, a
  `N more options` row shows on its own line between the list and the note
  row, so it never covers a row.
- **Minimize** (beside the decline `x`) folds the card to one line in the
  prompt box. It does not dismiss or unblock. The folded line shows the
  provider mark, `{header} - {question}`, and the answered count or `ANSWER`.
  iOS calls this `pendingInputCollapsed`; both share `foldedSummary`.

## Visual

- **Ledger rows:** a hairline between options, no per-option border, fill or
  radio glyph, always one column.
- **Selection:** a flush-right check; the leading number stays.
- **Two tints only:** the header mark and the selected check, from
  `--chat-accent`, so provider theming is automatic. One hairline top border on
  the composer means "answer mode".
- **Four type levels:** header 10px mono accent, question 15px sans, option
  label 12px mono, description 12px sans at 55%.

### Answered receipt

One expandable line (the `AdeCard` / `chatCardPrimitives` convention).
Expanded, it shows each question's header, answer and note, not every offered
option. A declined request records as declined.

The answers ride on `pending_input_resolved` (`answers?`), which syncs to every
paired device and the widget App Group, so:

- An `isSecret` question's answer is never written; the receipt shows
  `answer hidden`.
- The transcript copy is capped at about 2 KB with a truncation marker (an
  oversized synced event once took the desktop-brain socket down). The model
  still gets the full answer.

## Out of scope

Dropped on purpose: cross-device draft sync, an undo window on Send,
preselecting the recommended option, storing offered options on the resolved
event, a richer decline message to the model.
