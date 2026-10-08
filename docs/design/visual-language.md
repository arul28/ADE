# ADE visual language

This is how ADE looks, and how new UI should look. Read it before you build or
restyle any renderer surface: a page, a card, a settings section, a chart, a
picker. `theming.md` is the colour engine underneath it. `notices.md` is the one
source for banners, toasts, dialogs and z-index. This doc covers everything in
between.

The short version: **clean**. A picture or the theme's soft gradient is the
backdrop. Quiet, frosted cards float over it. Text is small and calm. Colour
means something: a status, a brand, a limit. Every number is real.

## Principles

1. **The backdrop is the hero; the UI floats.** The home page, the new chat page
   and the top bar sit on a scene: a full-window picture or the theme's animated
   mesh. Cards are translucent planes over it, never opaque slabs. Do not put a
   solid page background behind a surface that already has a scene.
2. **One vocabulary for boxes.** Every box of facts is a `.kit-card` with a
   40px `.kit-card-head`. Every settings page is `ModernPage` +
   `ModernSection` + `ModernRows`. A new surface reuses these. Do not write a new
   panel style; if the kit lacks something, add it to the kit.
3. **Colour is for meaning.** Neutral surfaces are the theme's `fg` mixed into
   `bg` at fixed steps (`--kit-hover`, `--kit-active`, `--kit-rule`,
   `--kit-track`). Colour appears only for status (ok, warn, crit), for brands
   (a provider's colour and logo, GitHub's PR states) and for the accent on the
   one thing that is selected. A grey meter that turns amber says more than a
   rainbow of meters.
4. **Show it, don't abbreviate it.** Use logos, avatars, state icons and full
   names. No two-letter machine chips, no `wk`/`5h` shorthand, no initials in a
   circle where a real name or picture fits. When a list is long, collapse it
   into one quiet chip ("3 machines") with a menu, not a row of tokens.
5. **Fit the window.** A dashboard does not scroll. It adapts: container queries
   drop the least important card or row as the window shrinks. Settings pages
   do scroll, as one calm column.
6. **Real data only.** Every number on screen comes from a real source. A
   metric whose source is unreliable is removed, not faked or estimated. Mock
   data lives in `browserMock.ts`, never in a component.
7. **Cheap to look at.** Animations run on the compositor or in steps. A
   surface that is always visible must cost close to nothing while idle.
   Measure it (see Performance).
8. **Fewer words.** A section has a title and at most one hint line. A row has a
   title, an optional hint and a control. Explain in a tooltip or a doc, not in
   a paragraph on the page. The plain-language rules in `AGENTS.md` still apply
   to every label.

## The surface kit

`apps/desktop/src/renderer/styles/surfaceKit.css` (imported once by
`index.css`). Plain CSS classes, so a component reads as markup rather than a
wall of utilities.

| Class | Use |
|---|---|
| `.kit-card` | The box. Rounded `--radius-lg`, hairline `--kit-card-edge`, translucent `--kit-card-bg`. Frosted on an image scene. |
| `.kit-card-head` | 40px header: icon, label, `.kit-card-head-count`, then `.kit-card-head-action` on the right. |
| `.kit-card-body` | Body padding. `data-flush="true"` for edge-to-edge lists. |
| `.kit-eyebrow` | 10px mono uppercase label with wide tracking. Section kickers, column labels. |
| `.kit-num` | Mono, tabular figures. Every number that can change. |
| `.kit-stat` | One big figure with its eyebrow. |
| `.kit-row` | A hover-highlighted list row. |
| `.kit-meter` | A thin bar with a `<span>` fill. `data-level="warn"` / `"crit"` recolours it. |
| `.kit-dot` | A 6px status dot. `data-state="ok"`, `"warn"`, `"crit"`, `"accent"`. |
| `.kit-tag` | A small tinted pill. `data-tone="ok"`, `"warn"`, `"crit"`. |
| `.kit-seg` | A segmented control. Buttons use `aria-pressed`, `aria-selected` or `aria-checked`. `data-case="sentence"` for non-mono labels. |
| `.kit-legend` | A chart legend item: swatch `<i>`, label, value `<b>`. |
| `.kit-icon-btn` | A borderless square icon button. |
| `.kit-btn` | A 30px text button for card surfaces (recovery and error screens). `.kit-btn-primary` is the one filled button per card, in the theme's ink; `.kit-btn-ghost` is borderless. |
| `.kit-rule` | A 1px divider. |

Variables worth knowing: `--kit-text-2` and `--kit-text-3` (secondary and
tertiary text), `--kit-fill` (a neutral meter fill), `--kit-ok`, `--kit-warn`,
`--kit-crit`, `--kit-panel-edge` and `--kit-panel-bg` (the grouped-rows panel in
settings).

A card, end to end:

```tsx
<section className="kit-card">
  <header className="kit-card-head">
    <GitPullRequest size={14} />
    Pull requests
    <span className="kit-card-head-count">{prs.length}</span>
    <button type="button" className="kit-card-head-action" onClick={openPrs}>
      View all
    </button>
  </header>
  <div className="kit-card-body" data-flush="true">
    {prs.map((pr) => <PrRow key={pr.id} pr={pr} />)}
  </div>
</section>
```

## Scenes: the backdrop

Code: `apps/desktop/src/renderer/scene/`, styles in `styles/scene.css`.

- **Modes.** `gradient` (the theme's animated mesh), `image` (one picture) or
  `shuffle` (a picture from the library, changed on launch, wake, hourly or
  daily). The shipped default is shuffle, a new picture on each wake, every
  picture included. Bumping `SCENE_DEFAULTS_REVISION` in `scenePreferences.ts`
  puts every user back on that default once; use it only for a deliberate
  product reset.
- **Pictures.** Bundled pictures are `public/scenes/*.jpg`, listed in
  `sceneLibrary.ts`. Users add their own; they are re-encoded to at most 3840px
  JPEG and stored in IndexedDB (`userScenes.ts`), never on disk or in sync.
- **One picture, many surfaces.** `SceneImageLayer` draws a window-aligned
  slice of the same picture behind each surface, so the top bar, the home page
  and the new chat page read as one continuous image. The Chats page and the
  Browser tab's chat dock sit on it too (`ChatSceneBackdrop`), each pane a
  frosted `.ade-chat-scene-plane` with the kit card's tint; Work chats do not.
- **The picture sets the colours.** `scenePalette.ts` extracts a palette from
  the picture (k-means, then a 5-stop ramp, cached in localStorage). The mesh
  gradient uses it. With **App colours: From picture** (`matchTheme`), the
  accent and a hint of the surfaces follow the picture too (`sceneTheme.ts`).
  With **From theme**, the theme keeps its own accent.
- **The veil.** The theme background lies over the picture at the user's `dim`
  strength, with a soft scrim behind the title bar so tab labels stay readable.
- **The document.** `html[data-scene="image"]` is set while a picture shows.
  Surfaces that must change over a picture (the kit cards go frosted; the ADE
  wordmark hides) key off that attribute, not off React state.
- **Right-click.** Empty background on the new chat page and the project picker
  opens a menu with **Change background**, which goes to Settings → Appearance
  (`BackgroundContextMenu.tsx`). Add the same hook to any new full-window
  backdrop surface.

Choosing pictures to bundle: landscape, at least 3840px wide, a calm area where
the cards will sit, no text or watermarks, and the right orientation in the
pixels themselves (check with `sips -g pixelWidth -g pixelHeight`; EXIF rotation
is not honoured everywhere).

## Layout

- **Container queries, not viewport queries.** The surface declares the
  container and its child holds the grid. A query on the element that is its
  own container never matches. Example: `ProjectWelcomePage.css` declares
  `container: welcome` and hides lower-priority rows under
  `@container welcome (max-height: 640px)`; `settingsModern.css` declares
  `modernpage` and stacks rows under 520px.
- **Home grid.** A hero line, a row of actions, then a grid of widgets
  (`components/home/`). The default preset is the shipped page: projects with
  what is working now, activity and usage, limits and machines, pull requests.
  Users pick widgets, a size class (Compact, Regular, Large) and an order;
  the layout engine fills the page with even rows and no gaps, and hides what
  does not fit behind "N hidden". Nothing scrolls: lists show the rows that
  fit and a "N more" line. Each widget is a size container, so a card hides
  its least important part when a layout makes it short.
- **Settings.** `ModernPage` spaces sections 44px apart. `ModernSection` is a
  title, a one-line hint and optional actions. `ModernRows` groups
  `ModernRow`s in one panel with hairline dividers. Choice cards (theme mode,
  backdrop mode) use `.ade-ap-grid3` and `.ade-ap-choice` with
  `data-active="true"`.
- **Hanging trays.** The new chat launch shelf hangs off the composer as a
  frosted strip (`.ade-chat-launch-shelf`). Keep attached trays attached; do not
  turn them into floating cards.

```tsx
<ModernPage>
  <ModernSection group="Notifications" anchor="notifications.desktop" title="On this computer" hint="How ADE gets your attention here.">
    <ModernRows>
      <ModernRow
        title="Stay quiet while ADE is focused"
        hint="Your phone still gets the alert."
        control={<SettingsToggle label="Stay quiet while ADE is focused" checked={quiet} onChange={setQuiet} />}
      />
    </ModernRows>
  </ModernSection>
</ModernPage>
```

`group` and `anchor` keep settings search and deep links working. Every new
row with a setting behind it needs an entry in `settingsManifest.ts`.

## Colour rules

- **Usage limits.** A limit is shown as headroom (percent left). Bars, rings
  and gauges stay neutral (or wear the provider's colour) while there is room,
  turn amber at 20% left and red at 5%: `usageLeftLevel` and
  `usageLeftLevelColor` in `usage/usageDesign.ts`. Every meter uses that one
  rule; do not invent thresholds per surface.
- **Providers.** Use the provider's logo (`usageProviderLogo`) and colour
  (`providerColor`) wherever a provider is named, and `humanizeProvider` for its
  name.
- **GitHub.** PR state icons in GitHub's own colours: open `#3fb950`, merged
  `#a371f7`, closed `#f85149`. Authors as avatars
  (`https://avatars.githubusercontent.com/<login>?size=40`, already allowed by
  the CSP). CI checks as a coloured dot plus a count.
- **Charts.** Small, flat and labelled in the style of the devl.dev chart
  kit: a sparkline or a bar row inside a card, one hue per series, a
  `.kit-legend` row, tabular mono values, a hover readout. An intensity map
  uses one hue at stepped strengths. Limit a chart to four series and fold the
  rest into "Other" (`USAGE_CHART_MAX_SERIES`).
- **Light themes.** Everything above must read on light themes. Tint with
  `--color-fg`, not white, and follow the light-mode rules in `theming.md`.

## Appearance page

Settings → This computer → Appearance is the model for a modern settings page:
mode cards (Light, Dark, Auto) with a live preview, a compact gallery of
theme circles (`<ThemeGallery compact />`), the backdrop picker with
shuffle options (when it changes, which pictures are in), and App colours
(From picture or From theme). Appearance is per computer and never syncs.

## Sign-in

The launch gate is a glass card over the ADE gradient
(`onboarding/GlassSignInCard.tsx`, `launchGateGlass.css`): the mark without a
box around it, one heading, the sign-in buttons. No extra labels, dividers or
"opens in your browser" copy.

## Performance

Visual polish must not cost CPU or GPU while ADE is idle.

- An always-visible animation runs in steps or on the compositor. The top-bar
  activity pulse uses a 4-step, 3s, `step-end` animation; a smooth infinite
  pulse there cost about a fifth of a core of GPU.
- `backdrop-filter` only on a few large planes (cards over a picture), never on
  list rows or anything that scrolls.
- Live data reloads on events with a debounce (for example `prs.onEvent`
  debounced 1s, plus window focus), not on a tight poll.
- Measure a new always-on surface with Chrome DevTools Performance metrics over
  CDP: main-thread milliseconds per second and layouts per second while idle.
  The home page measured about 5 ms/s and 0.1 layouts/s.

## Do and don't

| Do | Don't |
|---|---|
| `.kit-card` with a 40px head | a new bordered `div` with its own padding and radius |
| A logo, an avatar or a full name | two-letter chips or initials |
| One chip with a menu for a long list | a row of tokens that wraps |
| Neutral meters that turn amber at 20% left | per-provider rainbow bars, or a new threshold |
| Hide a card under a container query | let the home page scroll |
| Remove a metric you cannot source | estimate it or fill it with zeros |
| Frost over a picture with `html[data-scene="image"]` | read the scene from React state to restyle CSS |
| Step or compositor animations | infinite smooth animations on always-visible chrome |
| `ModernSection` + `ModernRows` in settings | a bespoke settings layout per page |
| Banners, toasts and dialogs from `notices.md` | a card that copies the banner look |

## iOS

`apps/ios/ADE/Views/Components/ADEKit.swift` is the iOS counterpart of the
surface kit and the modern settings primitives. It is flat (no materials,
glows, gradients or shadows), so it is cheap inside scrolling lists.

| Component | Desktop counterpart |
|---|---|
| `adeKitCard()`, `ADEKitCard`, `ADEKitCardHead` | `.kit-card`, `.kit-card-head` (40pt head: icon, label, count, action) |
| `ADEEyebrow`, `ADEKitStat` | `.kit-eyebrow`, `.kit-stat` |
| `ADEKitDot`, `ADEKitTag`, `ADEKitTone` | `.kit-dot`, `.kit-tag`, `data-state` / `data-tone`; `color:` for a hue that already means something, `keepsCase: true` for a user-chosen name |
| `ADEKitMeter`, `ADEKitLegendItem`, `ADEProviderMark` | `.kit-meter`, `.kit-legend`, `usageProviderLogo` |
| `ADEKitSegmented`, `ADEKitSegmentThumb` + `adeKitSegmentTrack()` | `.kit-seg` (every segmented control on iOS draws its thumb and track with these) |
| `adeKitPill()` | a menu or picker button's pill (surface, edge, capsule hit area); `adeKitPill(in:)` for another shape |
| `ADEKitButtonStyle`, `ADEKitRowButtonStyle` | buttons and `.kit-row`; both dim when disabled (`dimsWhenDisabled: false` for a row that draws its own unavailable state) |
| `ADEKitChip`, `ADEKitActionButton`, `ADEKitHoldButton` | small chips and capsule actions with a glyph |
| `ADEKit.chromeFill` / `chromeEdge`, `adeKitChrome(in:)` | the quiet top-bar surface shared by every round and capsule header control |
| `ADEKitCountSegments` | `.kit-seg` with glyph + count per option: a summary that is also a filter (Hub status counts, Activity state strip) |
| `ADEKitCircleIcon` | `.kit-icon-btn`: the quiet round top-bar button (Hub bell, add, settings, chats) |
| `adeKitField()` | a text field's well: the kit track, no glass |
| `prStateColor`, `PrStateIcon`, `PrStatePill` (`PRs/PrRowCard.swift`) | `--pr-open/merged/closed`, `.ade-home-pr-icon`, `.ade-home-pr-pill` |
| `ADESettingsPage`, `ADESettingsSection`, `ADESettingsRows`, `ADESettingsRow` (+ `ValueRow`, `Link`, `ActionRow`, `Notice`) | `ModernPage`, `ModernSection`, `ModernRows`, `ModernRow` |
| `adeSettingsList()`, `adeSettingsListRow()`, `ADESettingsListHeader` | the same panels in a `List`, for swipe actions; both headers draw through `ADESettingsHeader` |

`ADEKitButtonStyle(prominent: true, brand:)` fills a provider's own primary
button (Linear sign-in) with its brand colour; every other primary button is
the accent. `adeGlassCard` and `adeInsetField` remain only for the Work
composer and chat cards; everything else uses the kit card and field.

The usage headroom rule is `ADEUsagePressure` in `ADEUsageDesign.swift`
(amber at 20% left, red at 5%), the mirror of `usageLeftLevel`.

## Source map

| Area | Files |
|---|---|
| Kit | `renderer/styles/surfaceKit.css` |
| Scenes | `renderer/scene/*`, `renderer/styles/scene.css`, `public/scenes/` |
| Home | `components/projects/ProjectWelcomePage.tsx`, `ProjectWelcomeHome.tsx`, `ProjectWelcomeSidePanels.tsx`, `ProjectWelcomePage.css`, `components/home/*` |
| Settings | `components/settings/primitives/SettingsModern.tsx`, `settingsModern.css`, `AppearanceSection.tsx`, `ThemeGallery.tsx` |
| Usage | `components/usage/usageDesign.ts`, `UsageLimitGauges.tsx`, `UsageSparks.tsx`, `UsageWeekCompare.tsx`, `usageProviderNames.ts`, `usageSurfaces.css` |
| Sign-in | `components/onboarding/GlassSignInCard.tsx`, `launchGateGlass.css` |
