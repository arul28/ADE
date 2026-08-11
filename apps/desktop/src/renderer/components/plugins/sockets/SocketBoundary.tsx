import React from "react";

import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { SocketIcon } from "./socketUi";

/**
 * One contribution's blast radius.
 *
 * Wrapped around each mapped item rather than around the list, so a plugin
 * whose badge throws loses that badge and nothing else — its siblings, the row
 * it sits on and the tab around it all still render. Without it the nearest
 * catcher is the route's `PageErrorBoundary`, which means a single third-party
 * render error blanks a whole tab of the product's own content.
 *
 * The marker is deliberately almost nothing: a dimmed plugin glyph carrying the
 * explanation on hover. Someone reading a Lanes row does not need a red card
 * about a plugin they may not know is installed, and shouting about it would be
 * more disruptive than the failure it is reporting.
 */
export class SocketBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <span
        title="This plugin couldn’t show this."
        style={{
          display: "inline-flex",
          alignItems: "center",
          color: COLORS.textDim,
          fontFamily: SANS_FONT,
        }}
      >
        <SocketIcon size={11} color={COLORS.textDim} />
      </span>
    );
  }
}
