/** One provider on the top-level grid. Reads only the descriptor. */
import React from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { ProviderTile } from "../providerSectionPrimitives";
import {
  PreviewChip,
  ProviderStatusChip,
  normalizeProviderVersion,
  providerStatusColor,
} from "./providerUi";
import { providerStatusFor } from "./descriptors";
import type { ProviderDescriptor, ProvidersViewContext } from "./types";

/**
 * Four fixed rows: name, status, meta, message.
 *
 * 12px padding top and bottom (24) + a 22px logo row + 8px gap + the three
 * footer rows (16 + 6 + 14 + 6 + 28) comes to 124. Every tile reserves all four
 * whether or not it has something for the last one, because the alternative —
 * sizing to content — is what gave the healthy tiles a dead band and made the
 * grid look broken next to a tile with an error.
 */
const TILE_MIN_HEIGHT = 124;
/** Two lines at 10px · 1.4. The error line used to clamp to one and cut mid-sentence. */
const MESSAGE_ROW_HEIGHT = 28;

export function ProviderTileCard({
  descriptor,
  ctx,
  onOpen,
}: {
  descriptor: ProviderDescriptor;
  ctx: ProvidersViewContext;
  onOpen: () => void;
}) {
  const status = providerStatusFor(descriptor, ctx);
  const models = descriptor.models(ctx);
  const version = normalizeProviderVersion(descriptor.version?.(ctx));
  // A count of zero while the probe is still out is a claim we cannot make.
  // A disabled provider's count is real but beside the point — the tile's job
  // is to say it is off and to be clickable.
  const showModelCount = status.state !== "checking" && status.state !== "disabled";

  // The fourth row says one of two things. A provider in trouble gets the real
  // status sentence; a healthy one gets where its credential came from, which
  // is the only question a working provider still raises.
  const healthy = status.state === "connected";
  const problem = status.errorLine ?? (healthy ? null : status.message);
  const message = healthy ? descriptor.credentialLine?.(ctx) ?? null : problem;

  const metaParts = [
    ...(showModelCount ? [`${models.length} model${models.length === 1 ? "" : "s"}`] : []),
    ...(version ? [version] : []),
  ];

  return (
    <ProviderTile
      id={descriptor.id}
      name={descriptor.label}
      logo={descriptor.logo(22)}
      accentColor={providerStatusColor(status.state)}
      padding={12}
      minHeight={TILE_MIN_HEIGHT}
      wrapName
      ariaLabel={`Open ${descriptor.label} settings`}
      badge={descriptor.preview ? <PreviewChip /> : null}
      onOpen={onOpen}
      footer={
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div style={{ minHeight: 16, display: "flex", alignItems: "center" }}>
            <ProviderStatusChip state={status.state} label={status.label} />
          </div>
          <div
            style={{
              minHeight: 14,
              fontSize: 10,
              fontFamily: SANS_FONT,
              color: COLORS.textMuted,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {metaParts.join(" · ")}
          </div>
          <div
            style={{
              minHeight: MESSAGE_ROW_HEIGHT,
              fontSize: 10,
              fontFamily: SANS_FONT,
              // The dot and the accent rule already carry the state; red here
              // is reserved for a real probe failure so it still means something.
              color: status.errorLine ? COLORS.danger : COLORS.textDim,
              lineHeight: 1.4,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              overflowWrap: "anywhere",
            }}
            {...(message ? { title: message } : {})}
          >
            {message}
          </div>
        </div>
      }
    />
  );
}
