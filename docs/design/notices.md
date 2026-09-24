# Notices, dialogs, and overlays

Every banner, toast, confirm, prompt, modal, and top-bar sheet in the desktop
renderer uses one shared primitive. Feature code picks a tone, an icon, the
words, and the actions. It never styles the card, positions the overlay, or
picks a z-index. If none of the primitives below fits, extend the primitive in
its own folder. Do not build a one-off version in a feature folder.

| Primitive | Where |
|---|---|
| `Banner`, `useAppBanner`, `useAppBanners`, `APP_BANNER_PRIORITY`, `AppBannerHost` | `apps/desktop/src/renderer/components/ui/notice/` |
| `showToast`, `updateToast`, `dismissToast` | `components/app/toast/toastStore.ts` (rendered as `ToastCard` in `ToastViewport`) |
| `confirmDialog`, `promptDialog`, `Dialog`, `DialogHost` | `components/ui/dialog/` |
| `HeaderSheet` | `components/app/HeaderSheet.tsx` |
| `ViewportOverlayHost` | `components/ui/ViewportOverlayHost.tsx` |
| `noticeTone`, `NoticeTone` | `components/ui/notice/noticeTones.ts` |
| `Z_LAYERS` | `components/ui/zLayers.ts` |
| Durable dismissal | `renderer/lib/bannerDismiss.ts` |

## Which primitive

| What you are telling the user | Use |
|---|---|
| An app-wide state that lasts: signed out, update stuck, relay down, integration broken | `useAppBanner(model)` (docked, the default) |
| A short one-line prompt the user acts on or dismisses: a link in the clipboard | `useAppBanner(model, { placement: "floating", priority: APP_BANNER_PRIORITY.prompt })` |
| A state of one tab, pane, or panel: a lane needs a rebase, a PR is blocked | `<Banner model={...} layout="inline" />` inside that surface |
| Something that just happened: lane created, PR checks failed, undo available | `showToast({...})` |
| Yes/no before an action | `await confirmDialog({...})` |
| One line of text input | `await promptDialog({...})` |
| A modal with its own content: a form or a picker | `<Dialog open onOpenChange title ...>` |
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
| 60 | `prompt` | Short floating prompts. |
| 100 | `default` | Everything else. |

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
  folder. The banner goes away when the state resolves.

Toasts: `dismissible` defaults to true. `onClose` runs only when the user
clicks ×. It does not run on auto-dismiss.

## Toast timing

| Kind | `durationMs` |
|---|---|
| Ordinary event | omit it: the 6 s default |
| Worth reading: PR checks failed, review requested, a multi-line message | `18_000` (see `PR_TOAST_DURATION_MS`) |
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
| `chatDraftDeparture` | 79 | Departing Work draft chrome during the first-message handoff |
| `chatFirstMessageHandoff` | 80 | Composer and first-message handoff animation |
| `tabMenu` | 90 | Project-tab machine menu below sheets and app popovers |
| `popover` | 100 | Anchored pickers and menus (model picker, reasoning effort) |
| `sidebar` | 100 | The app sidebar |
| `sheet` | 120 | `HeaderSheet` top-bar dropdowns and their click-away layer |
| `hud` | 130 | The CTO voice-call HUD; above sheets so End call stays clickable |
| `floatingBanner` | 140 | Floating top-center banners |
| `dialog` | 200 | `Dialog` panel and scrim |
| `nestedDialog` | 210 | A confirm or prompt raised from inside another dialog |
| `toast` | 250 | `ToastViewport`; above dialogs so a toast raised from a dialog is visible |
| `tooltip` | 300 | Tooltips and hover cards, including ones inside dialogs |
| `contextMenu` | 9999 | A row context menu and its click-away layer |
| `capture` | 2147483000 | The global capture gesture notice, above everything |

`toast` sits above `dialog` because `ToastViewport` renders inside `<main>`,
which creates no stacking context, so its layer competes directly with the
body-portaled dialogs. Keep it that way: giving `<main>` (or an ancestor) a
z-index, transform, filter or `isolation` would trap toasts under dialogs again.

`ViewportOverlayHost` owns viewport anchoring and pointer passthrough for
transient overlays that are not banners, sheets, dialogs, or toasts, including
the call HUD, capture notice, and chat handoff animation. The hosts
(`ToastViewport`, `HeaderSheet`, `AppBannerHost`, `Dialog`, and
`ViewportOverlayHost`) already use named layers. If you need a z-index at all,
you are probably building an overlay the hosts already provide. A new layer
goes in `zLayers.ts`, with a comment explaining why the existing layers do not
work.

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
