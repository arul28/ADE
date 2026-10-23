/**
 * Scroll a list row into view and outline it briefly, for a surface opened to
 * "show this one" (a machine chip's Connections row, an MCP chip's server).
 * Returns the cleanup, which also clears the outline early.
 */
export function flashRowHighlight(
  row: HTMLElement,
  { block = "center", durationMs = 1400 }: { block?: ScrollLogicalPosition; durationMs?: number } = {},
): () => void {
  row.scrollIntoView({ block, behavior: "smooth" });
  row.style.outline = "1px solid var(--color-accent, #68a8ff)";
  row.style.outlineOffset = "4px";
  const clear = () => {
    row.style.outline = "";
    row.style.outlineOffset = "";
  };
  const timer = window.setTimeout(clear, durationMs);
  return () => {
    window.clearTimeout(timer);
    clear();
  };
}
