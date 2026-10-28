# Notices, dialogs, and overlays

Every banner, toast, confirm, prompt, modal, and top-bar sheet in the desktop
renderer uses one shared primitive. Feature code picks a tone, an icon, the
words, and the actions. It never styles the card, positions the overlay, or
picks a z-index. If none of the primitives below fits, extend the primitive in
its own folder. Do not build a one-off version in a feature folder.

| Primitive | Where |
|---|---|
| `Banner`, `useAppBanner`, `useAppBanners`, `APP_BANNER_PRIORITY`, `AppBannerHost`, `AppSuggestionCard` | `apps/desktop/src/renderer/components/ui/notice/` |
| `showToast`, `updateToast`, `dismissToast` | `components/app/toast/toastStore.ts` (rendered as `ToastCard` in `ToastViewport`) |
| `confirmDialog`, `promptDialog`, `Dialog`, `DialogHost` | `components/ui/dialog/` |
| `HeaderSheet` | `components/app/HeaderSheet.tsx` |
| `ContextMenu`, `ContextMenuEntry` (right-click menus built from a list of rows) | `components/ui/ContextMenu.tsx` |
| `ViewportOverlayHost` | `components/ui/ViewportOverlayHost.tsx` |
| `noticeTone`, `NoticeTone` | `components/ui/notice/noticeTones.ts` |
| `Z_LAYERS` | `components/ui/zLayers.ts` |
| Durable dismissal | `renderer/lib/bannerDismiss.ts` |

## Which primitive

| What you are telling the user | Use |
|---|---|
| An app-wide state that lasts: signed out, update stuck, relay down, integration broken | `useAppBanner(model)` (docked, the default) |
| A short one-line prompt the user acts on or dismisses: a link in the clipboard | `useAppBanner(model, { placement: "floating", priority: APP_BANNER_PRIORITY.prompt })` (`updatePrompt` keeps a ready-to-install update ahead of generic prompts) |
| A feature that would help right now, because ADE saw a signal: a lane template once a repo with packages has lanes | `useAppBanner(model, { placement: "suggestion", priority: APP_BANNER_PRIORITY.suggestion })` (see [Suggestions](#suggestions)) |
| A state of one tab, pane, or panel: a lane needs a rebase, a PR is blocked | `<Banner model={...} layout="inline" />` inside that surface |
| A short state of the chat a composer writes to: settled, snoozed, the lane is on another branch | `<StatusChip tone ...>` inside the composer's one `<StatusStrip>` (chips sit side by side; the explanation goes in `tooltip`) |
| Something that just happened: lane created, PR checks failed, undo available | `showToast({...})` |
| Yes/no before an action | `await confirmDialog({...})` |
| One line of text input | `await promptDialog({...})` |
| A modal with its own content: a form or a picker | `<Dialog open onOpenChange title ...>` |
| One thing to read beside the page you are on (an issue) | `<Dialog placement="right" ...>`, the side sheet |
| A dropdown that hangs off the top bar | `<HeaderSheet>` |

Rules of thumb. A banner describes a **state**: it stays while the state
holds and goes away when the state clears. A toast describes an **event**: it
reports something that happened and then goes away. If the user must answer
before anything else can happen, use a dialog.
Never call `window.confirm`, `window.prompt`, or `alert` in the renderer.

```tsx
import { APP_BANNER_PRIORITY, Banner, useAppBanner } from "../ui/notice";

// App-wide: register from wherever the state lives. The host decides order,
// cap (2 docked + "N more"), placement, and dismissal.
useAppBanner(
  relayDown && {
    id: "relay-down",
    tone: "warning",
    icon: <CloudSlash />,
    title: "Relay is unreachable",
    detail: "Phones and other machines can't reach this computer until it reconnects.",
    actions: [{ label: "Retry", onClick: retryRelay }],
    dismiss: { key: "relay-down", fingerprint: relayErrorCode },
  },
  { priority: APP_BANNER_PRIORITY.integration },
);

// About one surface: that surface places it.
<Banner layout="inline" model={{ id: "rebase", tone: "warning", title: "Behind main by 4 commits", actions: [{ label: "Rebase", onClick: rebase }] }} />
```

```ts
import { showToast } from "../app/toast/toastStore";
import { confirmDialog, promptDialog } from "../ui/dialog";

showToast({ tone: "success", title: "Lane created", message: "feature/login is ready." });

if (!(await confirmDialog({ title: "Delete lane?", message: "The worktree and its branch are removed.", confirmLabel: "Delete", destructive: true }))) return;

const name = await promptDialog({ title: "Rename lane", defaultValue: lane.name, confirmLabel: "Rename" });
if (name === null) return; // cancelled
```

## Tones

Six tones, from `noticeTone(tone)`. Color appears on the icon, the icon
tile, a faint border tint, and the primary action. It never fills the whole
row.

| Tone | Use when |
|---|---|
| `error` | Something failed or is unusable and the user must act (signed out, sync failed, checks failing). Renders with `role="alert"`. |
| `warning` | Degraded or at risk but still working (behind main, relay flaky, quota near). |
| `info` | Neutral status the user benefits from knowing (update available, lane created elsewhere). |
| `success` | A requested action finished (merged, lane ready). Mostly toasts; rarely a banner. |
| `accent` | A positive nudge or new capability (try this, a new feature). Use sparingly. |
| `neutral` | Quiet bookkeeping with no judgement attached (N sessions idle). |

When unsure, pick the least alarming tone that is still true.

## Icons and logos

- Omit `icon` to get the tone's default glyph.
- If the notice is about an integration (GitHub, Linear, an AI provider, the
  relay, an editor), pass that integration's **logo** as `icon`, so the user
  can see which service it is about before they read the text.
- If the notice is about an ADE feature, pass that feature's Phosphor glyph
  (lane, PR, chat).
- `busy: true` replaces the glyph with a spinner. Do not add your own spinner.

## Priority bands (app banners)

Lower numbers sort first. Pick the band that matches **what the banner blocks**.
Within a band, the more urgent tone wins, then the banner registered first.

| Band | `APP_BANNER_PRIORITY` | For |
|---|---|---|
| 0 | `account` | The account is unusable, or this computer was refused. |
| 10 | `project` | The open project is broken (missing folder, failed open). |
| 20 | `app` | ADE itself needs attention (update stuck, service recovered). |
| 30 | `outage` | An integration has an outage ADE cannot fix. |
| 50 | `integration` | An integration the user can fix (GitHub, AI provider, relay). |
| 55 | `updatePrompt` | A downloaded update is ready to install and should stay ahead of generic prompts. |
| 60 | `prompt` | Short floating prompts. |
| 80 | `suggestion` | Situational suggestions (placement `suggestion`). |
| 100 | `default` | Everything else. |

## Suggestions

A suggestion is onboarding's third tier: ADE shows a feature only when it
sees a signal that the feature would help now. It is not a state and not an
event, and it is never urgent, so it has its own quiet presentation:
`Banner` with `layout="suggestion"`, registered with
`useAppBanner(model, { placement: "suggestion", priority: APP_BANNER_PRIORITY.suggestion })`.

- **Where.** One small card in the bottom-right corner, rendered by the toast
  viewport (`ToastViewport`), which owns that corner. Toasts come and go above
  it; the live Launches panel sits below it. That corner covers no header, tab
  or composer and pushes nothing, and it is where ADE already puts things you
  may glance at and ignore. One suggestion shows at a time; the rest wait. It
  also waits while a modal or a first-chat onboarding hint is up.
- **What it says.** A quiet eyebrow (`eyebrow`, default "Suggestion"), a title
  that says what the feature **is** ("Lane templates make new lanes ready to
  work"), one "why now" line in `detail`, then two actions: the primary
  (`variant: "solid"`) and "Not now" (`variant: "secondary"`). No ×: "Not now"
  is the dismissal.
- **How it looks.** A tile from ADE Tips' wall (`.ade-suggest-card` in
  `ui/notice/notice.css`): a rounded plane with a hairline and a lit top edge,
  its hue glowing from a corner, a big tinted icon (pass the glyph at 21px,
  `weight="duotone"`), the eyebrow in the serif italic. `hue` sets the colour
  (a tip card wears its ADE Tips group's; default ADE violet) and `art` puts a
  screenshot in the bottom-right corner beside the actions. Only this layout
  looks like this; the other banners keep the banner look.
- **The signal.** Show it only when the user can already understand it. The
  lane template suggestion waits until the project has a lane besides the main
  checkout, so "lane" means something by then.
- **"Not now".** The kind is snoozed and the card is filed into ADE Tips with
  `postponeSuggestion` (`renderer/onboarding/adeTipsSuggestions.ts`, per
  computer). ADE Tips lists it under "Suggested for you", where the user can
  start it later (the owner registers a starter with
  `registerSuggestionStarter` while it can run, with the same pin it would use
  on the card) or turn it off for good ("Don't suggest again", the owner's
  `registerSuggestionKind` handler; per kind, or per project with
  `neverPerScope` as the lane template does). Add a new suggestion to `ADE_SUGGESTIONS`
  in that file so the card and the Tips row share one title and one line.
- **The shared rules.** Every suggestion goes through
  `useSituationalSuggestion` (`components/app/suggestions/`), which does the
  registering above and applies the rules every suggestion shares
  (`renderer/onboarding/situationalSuggestions.ts`): once per signal (or
  again after `repeatAfterMs`), one new card per launch, a four-hour cooldown
  after any card, and nothing during onboarding. The owner passes only its
  signal and its action. Never register a `suggestion` banner directly: it
  would skip those rules, and a suggestion that claimed the corner behind it
  would be used up unseen.

```tsx
useSituationalSuggestion({
  id: "lane-template", // title, line and action label come from ADE_SUGGESTIONS
  signalKey: templateWouldHelp && hasOwnLane ? scopeKey : null,
  tipsScopeKey: scopeKey,
  context: projectContext,
  start: templateWouldHelp ? startTemplateChat : null,
  repeatAfterMs: LANE_TEMPLATE_REPEAT_MS,
  neverPerScope: true,
});
```

## Dismissal

`BannerModel.dismiss` has three forms:

- **Durable** `{ key, fingerprint }`: `AppBannerHost` records it in
  `lib/bannerDismiss.ts` (localStorage), so it survives a restart. The
  fingerprint describes the exact state the user dismissed. If that state
  changes, the banner comes back. A dismissal also expires after a grace
  window (about two weeks), so a problem that is still there reminds the user
  again. Use this for app-wide states the user may reasonably ignore.
- **Owner-managed** `{ onDismiss, title? }`: the owner decides what dismissing
  means: keep it in memory, snooze it, or write it to a store. `title` is the
  × tooltip, for example "Dismiss for an hour".
- **None** (`false` or omitted): the banner cannot be dismissed. Use this for
  states the user cannot ignore, such as being signed out or a missing project
  folder. The banner goes away when the state resolves. A failure banner (see
  below) still gets a ×.

## Failures: one template

Every notice about a failure is a `Banner` (or a toast) with `tone: "error"`,
never a hand-styled red line. `Banner` then adds, with no wiring from the
owner:

- a × even when `dismiss` is omitted; it hides that exact failure until its
  text changes or the owner stops rendering it;
- **Details**, a fold with the raw error when it is not already on screen;
- **Report issue** (`ReportIssueButton`), which sends a redacted diagnostic
  report to ADE;
- one Sentry log, `notice.<surface>`, the first time that failure is shown.

`BannerModel.report` (`NoticeReport` in `ui/notice/NoticeReport.tsx`) names
the failure: `surface`, a stable `code`, and the raw `technicalDetail` when
the title is a friendly sentence. Pass it to give a warning that is really a
failure the same treatment (the "Claude runtime" banner, "Couldn't load
chats from <machine>"). Pass `report: false` for an error the person fixes
themselves, such as a required field. Error toasts get Details and Report the
same way; `showToast` already logs them to Sentry. Field-level validation
under an input stays plain text.

Toasts: `dismissible` defaults to true. `onClose` runs only when the user
clicks ×. It does not run on auto-dismiss.

## Toast timing

| Kind | `durationMs` |
|---|---|
| Ordinary event | omit it: the 6 s default |
| Worth reading: PR checks failed, review requested, a multi-line message | `READABLE_TOAST_DURATION_MS` (18 s, from `toastStore`) |
| Represents live state or needs an answer: a progress list, "N sessions idle" | `0` (sticky; dismiss or update it yourself) |

Hovering a toast pauses its timer. Pass a stable `id` to replace a toast in
place instead of stacking a new one, and use `updateToast(id, patch)` for
progress. At most 5 toasts show at once. When a sixth arrives, the oldest
timed toast is dropped. A sticky toast (`durationMs: 0`) is dropped only when
every toast on screen is sticky.

## Stacking: `Z_LAYERS`

Pick a named layer and never type a z-index:

| Layer | Value | For |
|---|---|---|
| `menuPanel` | 60 | A submenu panel floating off its host menu row. Relative, not absolute: the panel is a child of the host menu, so the host's own layer decides what the whole menu covers |
| `chatDraftDeparture` | 79 | Departing Work draft chrome during the first-message handoff |
| `chatFirstMessageHandoff` | 80 | Composer and first-message handoff animation |
| `onboardingHint` | 95 | Contextual onboarding hints after the tour (ADE cursor, ring, card). Under popovers, menus, sheets and dialogs, so anything the user opens covers a hint |
| `popover` | 100 | Anchored pickers and menus (model picker, reasoning effort) |
| `sidebar` | 100 | The app sidebar |
| `floatingBanner` | 115 | Floating top-center banners, below the sheets: a sheet someone just opened is what they are looking at, and a banner drawn over it covers its header |
| `sheet` | 120 | `HeaderSheet` top-bar dropdowns and their click-away layer |
| `dialog` | 200 | `Dialog` panel and scrim |
| `dialogPopover` | 205 | An anchored menu or picker opened from inside a dialog; below nested confirms |
| `nestedDialog` | 210 | A confirm or prompt raised from inside another dialog |
| `toast` | 250 | `ToastViewport`; above dialogs so a toast raised from a dialog is visible |
| `tooltip` | 300 | Tooltips and hover cards, including ones inside dialogs |
| `contextMenu` | 9999 | A row context menu and its click-away layer |
| `onboardingTour` | 10000 | The guided onboarding tour (ADE cursor, ring, card). Above menus, because a step points into an open menu. Only the small card takes pointer events, it sits beside its control, and the tour hides while a modal is open |
| `capture` | 2147483000 | The global capture gesture notice, above everything |

`toast` sits above `dialog` because `ToastViewport` renders inside `<main>`,
which creates no stacking context, so its layer competes directly with the
body-portaled dialogs. Keep it that way: giving `<main>` (or an ancestor) a
z-index, transform, filter or `isolation` would trap toasts under dialogs again.

`ViewportOverlayHost` owns viewport anchoring and pointer passthrough for
transient overlays that are not banners, sheets, dialogs, or toasts, including
the capture notice and chat handoff animation. The hosts
(`ToastViewport`, `HeaderSheet`, `AppBannerHost`, `Dialog`, and
`ViewportOverlayHost`) already use named layers. If you need a z-index at all,
you are probably building an overlay the hosts already provide. A new layer
goes in `zLayers.ts`, with a comment explaining why the existing layers do not
work.

These layers order surfaces across the app. Inside one surface — a find bar
over its own transcript or diff, a pill over its own list — the small Tailwind
steps (`z-10` to `z-40`) order that surface's children against each other.
They create no stacking context, so they share one with their neighbours:
keep them below every `Z_LAYERS` value (all are 60 or more) and do not use
them for anything that must cover another surface. The lint only flags `z-50`
and arbitrary `z-[N]` with N ≥ 50, so this rule is yours to keep.

## Copy

Follow the "Style preferences" section of `AGENTS.md`: use direct, operational
language and sentence case.

- The title states what happened or what is wrong ("Relay is unreachable"), not
  a category label ("Connection error").
- The detail says what the problem blocks and what happens next. It is one or
  two short sentences. Never include stack traces or raw error codes. Put those
  behind an action.
- Action labels are verbs ("Retry", "Sign in", "Rebase"). A destructive confirm
  uses the verb as `confirmLabel` ("Delete"), not "OK".
- Say "lane", not "worktree".

## Lint rules and the ratchet

The local plugin `apps/desktop/eslint-rules/ade-ui.mjs` checks
`src/renderer/**`. It skips tests and the primitives themselves. Every rule is
a **warning**:

| Rule | Flags | Use instead |
|---|---|---|
| `ade-ui/no-native-dialogs` | `window.confirm/prompt/alert`, bare `confirm()` / `alert()` / `prompt()` | `confirmDialog`, `promptDialog`, `showToast` |
| `ade-ui/no-adhoc-notice-component` | A `*Banner` / `*Toast` / `*Notice` / `*Callout` / `*Snackbar` component in a file that imports nothing from `ui/notice` or `app/toast` | `Banner`, `useAppBanner`, `showToast` |
| `ade-ui/no-fixed-overlay` | `position: "fixed"`, a `fixed` class in `className` / `cn()` / `clsx()` | `AppBannerHost`, `ToastViewport`, `Dialog`, `HeaderSheet`, `ViewportOverlayHost` |
| `ade-ui/no-raw-z-index` | `zIndex` ≥ 50, `z-50`, `z-[N]` with N ≥ 50 | `Z_LAYERS` |
| `ade-ui/no-legacy-banner-import` | `components/shared/Banner`, `sonner`, `react-hot-toast`, `@radix-ui/react-toast`, `react-toastify` | `ui/notice`, `showToast` |

CI runs `npm run lint:ci` (`apps/desktop/scripts/lint-ratchet.mjs`) in the
`lint-desktop` job. The script lints once and fails on any error, as
`npm run lint` does. It also compares each file's count for each `ade-ui/*`
rule against `apps/desktop/lint-baseline.json` and **fails if any count goes
up**, including for a file that had no violations before. When counts go down,
the script prints a reminder to lock in the lower numbers:

```bash
cd apps/desktop
npm run lint:ci                # what CI runs; add -- --warnings to list every warning
npm run lint:baseline          # rewrite lint-baseline.json after fixing violations
npm run test:lint-tooling      # rule + ratchet unit tests (node --test)
```

Run `lint:baseline` when you fix violations, and commit the smaller baseline.
Never raise the baseline to get a feature through CI. The only exception is a
new shared primitive, and the PR must explain it.

The lint cannot catch everything. For example, it misses a hand-built card
that copies the banner look using a class constant, or a scrim with a
non-fixed position. Reviewers (and `/quality`) should flag these by eye.

## Adding a new notice: checklist

1. State or event? Use the table in [Which primitive](#which-primitive).
   Banner means state, toast means event, and a dialog means the user must
   answer.
2. Pick the tone. Use the least alarming one that is still true.
3. Pick the icon. Use the integration's logo when the notice is about an
   integration. Otherwise omit it or use the feature's glyph.
4. Write the copy: a title that states the problem, a detail that says what it
   blocks, and verb actions.
5. App banner: pick a priority band and a dismissal kind. For a durable
   dismissal, use a fingerprint that changes when the state changes.
6. Toast: pick the timing (6 s, 18 s, or sticky), and set a stable `id` if it
   can repeat or update.
7. Do not add `position: fixed`, a z-index, a new `*Banner` component with its
   own styling, or a toast library.
8. Run `npm run lint:ci` in `apps/desktop`. It must report no new `ade-ui`
   violations.
