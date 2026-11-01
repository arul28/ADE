import React from "react";
import { COLORS } from "../../lanes/laneDesignTokens";

/** The Custom provider editor's field error line, one style for every field. */
export function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" style={{ margin: 0, fontSize: 10.5, color: COLORS.danger }}>{children}</p>
  );
}
