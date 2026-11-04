/** The Apple panel's small inline spinner (a pending start, an install, a removal). */
export function Spinner() {
  return (
    <span
      aria-hidden="true"
      data-apple-spinner=""
      className="h-3 w-3 shrink-0 animate-spin rounded-full border border-muted-fg/35 border-t-accent"
    />
  );
}
