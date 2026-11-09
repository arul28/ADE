import { Cloud } from "@phosphor-icons/react";

export const ADE_CLOUD_NAME = "ADE Cloud";

/** ADE Cloud's mark. `bold` draws it heavier at small sizes. */
export function CloudMark({
  size = 14,
  className,
  color = "currentColor",
  bold = false,
}: {
  size?: number | string;
  className?: string;
  color?: string;
  bold?: boolean;
}) {
  return <Cloud size={size} className={className} color={color} weight={bold ? "bold" : "regular"} aria-hidden="true" style={{ display: "block" }} />;
}
