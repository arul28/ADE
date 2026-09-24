/**
 * The Mac Desktop namespace, or a stated absence.
 *
 * Every call the panel and its hooks make goes through here so that a surface
 * without the namespace shows an error line instead of throwing out of an
 * effect and taking the Work pane with it.
 */
export function macDesktopApi(): NonNullable<Window["ade"]["macDesktop"]> {
  const api = window.ade.macDesktop;
  if (!api) throw new Error("Mac Desktop is not available on this surface.");
  return api;
}
