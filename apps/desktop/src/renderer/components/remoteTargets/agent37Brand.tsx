/**
 * Agent 37's own mark: the outlined, folded diamond from agent37.com/logo.svg
 * (viewBox 0 0 512 512, stroke-only, drawn in currentColor). Their brand is
 * monochrome: black and white, no accent color.
 */
const AGENT37_LOGO_PATHS = [
  "M226.31 69.18 L280.18 69.18 L442.82 231.82 L442.82 278.38 L284.11 437.1 L230.73 437.1 L68.93 275.3 L68.93 226.56 Z",
  "M281.22 70.22 L126.17 225.26 L256.67 355.76",
  "M73.6 221.89 L232.07 380.36 L354.43 258",
  "M230.19 436.56 L381.59 285.16 L249.23 152.8",
  "M438.45 282.76 L278.86 123.17 L151.47 250.56",
] as const;

/** Their wordmark spells it with a space; the API, CLI and template ids use `agent37`. */
export const AGENT37_NAME = "Agent 37";

export function Agent37Mark({
  size = 14,
  className,
  color = "currentColor",
  strokeWidth = 12.46,
}: {
  size?: number | string;
  className?: string;
  color?: string;
  /** Their file's weight at 512 units. Small sizes read better a little heavier. */
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ display: "block" }}
    >
      {AGENT37_LOGO_PATHS.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
