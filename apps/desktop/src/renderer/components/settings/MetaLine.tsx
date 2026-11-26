import React from "react";

/**
 * A row's meta line (Archive, Recently deleted): items joined by "·" that wrap
 * in a narrow column. Each item draws its "·" in front of itself, and the line
 * clips the one at the start of every visual line, so no line starts or ends
 * with a separator (`machineSettings.css`, `.ade-ar-meta`).
 */
export function MetaLine({ items }: { items: React.ReactNode[] }) {
  return (
    <span className="ade-ar-meta">
      <span className="ade-ar-meta-items">
        {items.filter((item) => item != null && item !== false && item !== "").map((item, index) => (
          <span key={index} className="ade-ar-meta-item">{item}</span>
        ))}
      </span>
    </span>
  );
}
