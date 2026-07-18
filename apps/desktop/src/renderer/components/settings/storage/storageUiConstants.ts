import type React from "react";

// Shared presentational constants for the Storage settings surface. Extracted
// so the section shell and the split-out Diagnostics/Journal components can
// share them without a circular import back through StorageSection.

export const STORAGE_BRAND = "#38BDF8";

export const PANEL_STYLE: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-card) 90%, var(--color-bg) 10%)",
  border: "1px solid color-mix(in srgb, var(--color-border) 78%, transparent)",
  borderRadius: 12,
  padding: 16,
};
