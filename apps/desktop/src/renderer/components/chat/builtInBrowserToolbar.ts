/**
 * How much toolbar fits, decided from the row's own measured width.
 *
 * Layout only: the words the controls carry live in `browserToolbarLabels.ts`,
 * the native-view arithmetic in `browserViewGeometry.ts`, dev-server discovery
 * in `browserDevServers.ts`, and the URL rules in `lib/browserUrl.ts`. Keeping
 * them apart is what lets a caller that needs `browserLetterboxFrame` stop
 * importing a module named after a toolbar.
 */

/**
 * The narrowest a URL field is still a URL field.
 *
 * Below this it stops being able to show a host, so the row must give up a
 * control instead: an omnibox squeezed to nothing is a browser you cannot
 * steer, and every other button on the row is a convenience by comparison.
 */
export const BROWSER_TOOLBAR_URL_MIN_WIDTH = 140;

/** Above this the field can afford the word "Open" next to the ▶ glyph. */
export const BROWSER_TOOLBAR_OPEN_LABEL_MIN_WIDTH = 520;

/**
 * What each control costs the row, in CSS px, at its laid-out size.
 *
 * These are the widths the toolbar's own classes produce: `w-7` icon buttons
 * are 28, the nav group is three of them inside one border, `gap-1` is 4 and
 * the row's `px-1.5` is 6 a side. They live here rather than being measured per
 * control because the decision has to be made in the same frame as the resize —
 * measuring children that are about to be removed is how a layout starts
 * oscillating.
 */
export type BrowserToolbarControlWidths = {
  /** Back + forward + reload in one bordered group. */
  nav: number;
  /** Back + reload, once forward has been dropped. */
  navNoForward: number;
  device: number;
  deviceIcon: number;
  camera: number;
  inspect: number;
  inspectIcon: number;
  attach: number;
  recording: number;
  overflow: number;
  gap: number;
  padding: number;
  /** The padlock and its gap, always reserved so the row cannot jump on load. */
  urlLock: number;
  /** The omnibox's own left padding. */
  urlPadding: number;
  openLabel: number;
  openIcon: number;
};

export const BROWSER_TOOLBAR_CONTROL_WIDTHS: BrowserToolbarControlWidths = {
  nav: 86,
  navNoForward: 58,
  device: 90,
  deviceIcon: 28,
  camera: 28,
  inspect: 72,
  inspectIcon: 28,
  attach: 70,
  recording: 96,
  overflow: 28,
  gap: 4,
  padding: 12,
  urlLock: 17,
  urlPadding: 8,
  openLabel: 60,
  openIcon: 34,
};

/**
 * What the device button costs with `label` on it.
 *
 * "Desktop" and "iPhone 17 Pro Max · landscape" are not the same button, and
 * the row that decides what fits has to price the one it is actually going to
 * render. Clamped at the button's own `max-w-[104px]` truncation.
 */
export function estimateDeviceButtonWidth(label: string | null | undefined): number {
  const text = (label ?? "").trim();
  const textWidth = Math.min(104, Math.max(28, Math.round(text.length * 6.4)));
  // icon 12 + gap 4 + text + caret 9 + gap 4 + px-2 padding 16.
  return textWidth + 45;
}

export type BrowserToolbarDensity = "full" | "compact" | "tight" | "minimal";

/** How the URL field offers to submit: with a word, a glyph, or not at all. */
export type BrowserToolbarOpenAffordance = "label" | "icon" | "none";

export type BrowserToolbarLayout = {
  density: BrowserToolbarDensity;
  /** Text next to an icon: the device name, "Inspect". */
  showLabels: boolean;
  showForward: boolean;
  showDevice: boolean;
  showCamera: boolean;
  showInspect: boolean;
  showAttach: boolean;
  openAffordance: BrowserToolbarOpenAffordance;
  /** What the URL field is left with once everything above is placed. */
  urlWidth: number;
};

export type BrowserToolbarLayoutOptions = {
  /** A selection is attached, so the row would like an "Attach" button. */
  hasSelection?: boolean;
  /** A recording is running; its pill is state, not a convenience, so it stays. */
  recording?: boolean;
  /** The device button's rendered label, which decides how wide it is. */
  deviceLabel?: string | null;
  /** The omnibox is focused: Enter submits, so the ▶ affordance steps aside. */
  urlFocused?: boolean;
  urlMinWidth?: number;
  widths?: Partial<BrowserToolbarControlWidths>;
};

type BrowserToolbarStep = Pick<
  BrowserToolbarLayout,
  "density" | "showLabels" | "showForward" | "showDevice" | "showCamera" | "showInspect" | "showAttach"
>;

/**
 * The order things are given up in.
 *
 * Labels first (an icon still says what it does), then Inspect, then the
 * camera, then the device button — each into the ⋮ menu, which is why the ⋮ is
 * never in this list. Forward goes last of all: it is the only one whose
 * absence loses a capability the menu does not carry.
 */
const BROWSER_TOOLBAR_STEPS: readonly BrowserToolbarStep[] = [
  { density: "full", showLabels: true, showForward: true, showDevice: true, showCamera: true, showInspect: true, showAttach: true },
  { density: "full", showLabels: true, showForward: true, showDevice: true, showCamera: true, showInspect: true, showAttach: false },
  { density: "compact", showLabels: false, showForward: true, showDevice: true, showCamera: true, showInspect: true, showAttach: false },
  { density: "compact", showLabels: false, showForward: true, showDevice: true, showCamera: true, showInspect: false, showAttach: false },
  { density: "tight", showLabels: false, showForward: true, showDevice: true, showCamera: false, showInspect: false, showAttach: false },
  { density: "tight", showLabels: false, showForward: true, showDevice: false, showCamera: false, showInspect: false, showAttach: false },
  { density: "minimal", showLabels: false, showForward: false, showDevice: false, showCamera: false, showInspect: false, showAttach: false },
];

/**
 * How much toolbar fits in `width`, measured rather than guessed.
 *
 * The old version keyed off two hardcoded pane widths, and at ~420px every
 * control was still "allowed" — nav 86 + device 90 + camera 28 + inspect 72 +
 * ⋮ 28 + gaps left 84px for a field that also had to hold a lock and the word
 * "Open", so the input collapsed to zero and the omnibox vanished. Now the row
 * prices what it is about to render and sheds controls, in the order above,
 * until the field clears `urlMinWidth`.
 */
export function browserToolbarLayout(
  width: number | null | undefined,
  options: BrowserToolbarLayoutOptions = {},
): BrowserToolbarLayout {
  const widths = { ...BROWSER_TOOLBAR_CONTROL_WIDTHS, ...options.widths };
  const urlMin = options.urlMinWidth ?? BROWSER_TOOLBAR_URL_MIN_WIDTH;
  const measured = typeof width === "number" && Number.isFinite(width) && width > 0 ? width : null;
  const deviceWidth = options.deviceLabel != null
    ? estimateDeviceButtonWidth(options.deviceLabel)
    : widths.device;
  const naturalAffordance: BrowserToolbarOpenAffordance = options.urlFocused
    ? "none"
    : measured == null || measured >= BROWSER_TOOLBAR_OPEN_LABEL_MIN_WIDTH
      ? "label"
      : "icon";

  const price = (step: BrowserToolbarStep, openAffordance: BrowserToolbarOpenAffordance) => {
    const showAttach = step.showAttach && Boolean(options.hasSelection);
    let controls = 0;
    // nav + omnibox + ⋮ are always on the row.
    let items = 3;
    controls += step.showForward ? widths.nav : widths.navNoForward;
    controls += widths.overflow;
    // What the omnibox spends on itself before the text field gets any: the
    // padlock, its own padding, and whatever the submit affordance costs. The
    // field's share is what is left of that, which is the number that has to
    // clear the minimum — pricing the omnibox as a whole is what left a 101px
    // field inside a "comfortable" 180px box.
    controls += widths.urlPadding + widths.urlLock;
    if (openAffordance === "label") controls += widths.openLabel;
    else if (openAffordance === "icon") controls += widths.openIcon;
    if (options.recording) {
      controls += widths.recording;
      items += 1;
    }
    if (step.showDevice) {
      controls += step.showLabels ? deviceWidth : widths.deviceIcon;
      items += 1;
    }
    if (step.showCamera) {
      controls += widths.camera;
      items += 1;
    }
    if (step.showInspect) {
      controls += step.showLabels ? widths.inspect : widths.inspectIcon;
      items += 1;
    }
    if (showAttach) {
      controls += widths.attach;
      items += 1;
    }
    const consumed = widths.padding + controls + widths.gap * (items - 1);
    const urlWidth = measured == null ? Number.POSITIVE_INFINITY : measured - consumed;
    return { step, showAttach, openAffordance, urlWidth };
  };

  // The ▶ is the last thing to go, after every control has already moved into
  // the ⋮ menu: it is only ever a hint that Enter works, and at the width where
  // it is the difference it is cheaper to lose than the field it sits in.
  const priced = [
    ...BROWSER_TOOLBAR_STEPS.map((step) => price(step, naturalAffordance)),
    price(BROWSER_TOOLBAR_STEPS[BROWSER_TOOLBAR_STEPS.length - 1], "none"),
  ];

  const chosen = priced.find((entry) => entry.urlWidth >= urlMin) ?? priced[priced.length - 1];
  return {
    ...chosen.step,
    showAttach: chosen.showAttach,
    openAffordance: chosen.openAffordance,
    urlWidth: Number.isFinite(chosen.urlWidth) ? Math.max(0, Math.round(chosen.urlWidth)) : urlMin,
  };
}
