import { Cloud } from "@phosphor-icons/react";

export const ADE_CLOUD_NAME = "ADE Cloud";

/** ADE Cloud's mark. `strokeWidth` is accepted so a caller can draw it heavier at small sizes. */
export function CloudMark({
  size = 14,
  className,
  color = "currentColor",
  strokeWidth,
}: {
  size?: number | string;
  className?: string;
  color?: string;
  strokeWidth?: number;
}) {
  return <Cloud size={size} className={className} color={color} weight={strokeWidth != null ? "bold" : "regular"} aria-hidden="true" style={{ display: "block" }} />;
}
