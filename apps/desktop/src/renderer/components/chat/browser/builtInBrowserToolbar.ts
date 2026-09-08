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

/**
 * What each control costs the row, in CSS px, at its laid-out size.
 *
 * Every control on the chrome row is now the same 28px ghost square, so these
 * are one number repeated rather than six measurements — which is the point:
 * the row that had a 90px device chip, a 72px "Inspect" and a 96px REC pill is
 * the row that ran out of width at 420px. They live here rather than being
 * measured per control because the decision has to be made in the same frame as
 * the resize — measuring children that are about to be removed is how a layout
 * starts oscillating.
 */
export type BrowserToolbarControlWidths = {
  /** Back + forward + reload, three 28px glyphs at a 2px gap. */
  nav: number;
  /** Back + reload, once forward has been dropped. */
  navNoForward: number;
  /** Any one glyph in the right cluster. */
  control: number;
  overflow: number;
  gap: number;
  padding: number;
  /** The padlock and its gap, always reserved so the row cannot jump on load. */
  urlLock: number;
  /** The omnibox's own horizontal padding. */
  urlPadding: number;
};

export const BROWSER_TOOLBAR_CONTROL_WIDTHS: BrowserToolbarControlWidths = {
  nav: 88,
  navNoForward: 58,
  control: 28,
  overflow: 28,
  gap: 2,
  padding: 16,
  urlLock: 18,
  urlPadding: 16,
};

export type BrowserToolbarDensity = "full" | "compact" | "tight" | "minimal";

export type BrowserToolbarLayout = {
  density: BrowserToolbarDensity;
  showForward: boolean;
  showDevice: boolean;
  showCamera: boolean;
  showInspect: boolean;
  showAttach: boolean;
  /** "Open externally" — the one right-cluster glyph that is pure convenience. */
  showPopOut: boolean;
  /** What the URL field is left with once everything above is placed. */
  urlWidth: number;
};

export type BrowserToolbarLayoutOptions = {
  /** A selection is attached, so the row would like an "Attach" button. */
  hasSelection?: boolean;
  /**
   * This host can receive inserted context.
   *
   * False in a shell session, where there is nothing to insert INTO: Inspect
   * and Attach then have no destination and are not priced or placed at all.
   * Removed rather than disabled — a control that can never work here is not a
   * transient state a tooltip can explain away.
   */
  canAttachContext?: boolean;
  /**
   * A recording is running.
   *
   * The camera carries the recording state now, so a recording pins the camera
   * onto the row rather than adding a pill next to it.
   */
  recording?: boolean;
  urlMinWidth?: number;
  widths?: Partial<BrowserToolbarControlWidths>;
};

type BrowserToolbarStep = Pick<
  BrowserToolbarLayout,
  "density" | "showForward" | "showDevice" | "showCamera" | "showInspect" | "showAttach" | "showPopOut"
>;

/**
 * The order things are given up in.
 *
 * Attach first (it is one menu row away), then pop-out, then Inspect, then the
 * camera, then the device button — each into the ⋯ menu, which is why the ⋯ is
 * never in this list. Forward goes last of all: it is the only one whose
 * absence loses a capability the menu does not carry.
 */
const BROWSER_TOOLBAR_STEPS: readonly BrowserToolbarStep[] = [
  { density: "full", showForward: true, showDevice: true, showCamera: true, showInspect: true, showAttach: true, showPopOut: true },
  { density: "full", showForward: true, showDevice: true, showCamera: true, showInspect: true, showAttach: false, showPopOut: true },
  { density: "compact", showForward: true, showDevice: true, showCamera: true, showInspect: true, showAttach: false, showPopOut: false },
  { density: "compact", showForward: true, showDevice: true, showCamera: true, showInspect: false, showAttach: false, showPopOut: false },
  { density: "tight", showForward: true, showDevice: true, showCamera: false, showInspect: false, showAttach: false, showPopOut: false },
  { density: "tight", showForward: true, showDevice: false, showCamera: false, showInspect: false, showAttach: false, showPopOut: false },
  { density: "minimal", showForward: false, showDevice: false, showCamera: false, showInspect: false, showAttach: false, showPopOut: false },
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

  const canAttachContext = options.canAttachContext !== false;
  const price = (step: BrowserToolbarStep) => {
    const showInspect = step.showInspect && canAttachContext;
    const showAttach = step.showAttach && Boolean(options.hasSelection) && canAttachContext;
    // A running recording is state, not a convenience: the camera stays on the
    // row to carry it however narrow the pane gets.
    const showCamera = step.showCamera || Boolean(options.recording);
    let controls = 0;
    // nav + omnibox + ⋯ are always on the row.
    let items = 3;
    controls += step.showForward ? widths.nav : widths.navNoForward;
    controls += widths.overflow;
    // What the omnibox spends on itself before the text field gets any: the
    // padlock and its own padding. The field's share is what is left of that,
    // which is the number that has to clear the minimum — pricing the omnibox
    // as a whole is what left a 101px field inside a "comfortable" 180px box.
    controls += widths.urlPadding + widths.urlLock;
    for (const shown of [step.showDevice, showCamera, showInspect, showAttach, step.showPopOut]) {
      if (!shown) continue;
      controls += widths.control;
      items += 1;
    }
    const consumed = widths.padding + controls + widths.gap * (items - 1);
    const urlWidth = measured == null ? Number.POSITIVE_INFINITY : measured - consumed;
    return { step, showInspect, showAttach, showCamera, urlWidth };
  };

  const priced = BROWSER_TOOLBAR_STEPS.map((step) => price(step));
  const chosen = priced.find((entry) => entry.urlWidth >= urlMin) ?? priced[priced.length - 1];
  return {
    ...chosen.step,
    showInspect: chosen.showInspect,
    showAttach: chosen.showAttach,
    showCamera: chosen.showCamera,
    urlWidth: Number.isFinite(chosen.urlWidth) ? Math.max(0, Math.round(chosen.urlWidth)) : urlMin,
  };
}
