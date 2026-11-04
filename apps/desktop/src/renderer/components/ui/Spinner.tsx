/** The small inline spinner of the device tools: a pending start, an install, a removal, a boot. */
export function Spinner() {
  return (
    <span
      aria-hidden="true"
      data-device-spinner=""
      className="h-3 w-3 shrink-0 animate-spin rounded-full border border-muted-fg/35 border-t-accent"
    />
  );
}
