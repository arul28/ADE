/**
 * One provider tile of Settings › Providers, as markup only: the logo, the
 * name, one or two fact lines, the status chip, and an action at the end (a
 * button, or a switch). A computer's tiles (`ProviderCard`) and ADE Cloud's
 * tiles (`AdeCloudProvidersView`) decide what a tile says; this draws it, so
 * both places look the same.
 */
import React from "react";
import { ToolLogo } from "../../terminals/ToolLogos";
import { DevinMark } from "../../shared/ProviderLogos";
import { PreviewChip } from "./providerUi";
import { SettingsToggle } from "../primitives";
import type { ProviderDescriptor } from "./types";
import type { TerminalToolType } from "../../../../shared/types";

/**
 * The provider's mark with no box around it, for the list: the bare glyph in
 * its maker's colour (`ToolLogo`'s provider-mark look). The default logos are
 * app-icon avatars — a filled square or circle — which read as a box in a box
 * at this size. Devin's tool logo is its boxed app icon, so it takes the bare
 * Cognition glyph; a provider with no bare mark keeps its own logo.
 */
// Muse and Pi are left out: their own logos are already bare images (Meta's
// mark, the Pi glyph), and their masked provider-marks draw as a solid square.
const BARE_MARK_TOOLS: ReadonlySet<string> = new Set([
  "claude", "codex", "cursor", "droid", "copilot", "opencode", "qwen", "kimi", "grok",
]);

export function providerListMark(descriptor: ProviderDescriptor, size: number): React.ReactNode {
  if (descriptor.id === "devin") return <DevinMark size={size} />;
  if (BARE_MARK_TOOLS.has(descriptor.id)) {
    return <ToolLogo toolType={descriptor.id as TerminalToolType} size={size} appearance="provider-mark" />;
  }
  return descriptor.logo(size);
}

export type ProviderTileFact = {
  text: string;
  /** A fact that warns (a sign-in that ends soon) or says something ended. */
  tone?: "warn" | "crit";
  /** A line that says why or what to do and must never be cut: it wraps as far as it needs. */
  whole?: boolean;
};

export type ProviderTileAction =
  | { kind: "button"; label: string; aria: string; run: () => void; busy?: boolean }
  | { kind: "switch"; aria: string; checked: boolean; run: (next: boolean) => void; busy?: boolean };

export function ProviderTileView({
  descriptor,
  state,
  chipLabel,
  chipTone,
  facts,
  accent,
  onOpen,
  action,
  hidden = false,
  row,
  wrapFacts = false,
}: {
  descriptor: ProviderDescriptor;
  /** Drives the tile's dim and fact colour (`data-state`). */
  state: string;
  chipLabel: string;
  chipTone: string | undefined;
  /** At most two short lines; the first one only when there is one. */
  facts: readonly ProviderTileFact[];
  /** `--pvl-accent`: the provider's brand colour. */
  accent: string;
  /** Opens the provider's page. Without it the tile is not a button. */
  onOpen?: () => void;
  action?: ProviderTileAction | null;
  /** Folded away with "Not set up". */
  hidden?: boolean;
  /** Which state row decided the tile (`data-row`), for the mock preview. */
  row?: string;
  /** Every fact line wraps instead of being cut (ADE Cloud: the account and the why must be readable). */
  wrapFacts?: boolean;
}) {
  const body = (
    <>
      <span className="ade-pvl-logo" aria-hidden>{providerListMark(descriptor, 30)}</span>
      <span className="ade-pvl-id">
        <span className="ade-pvl-name-row">
          <span className="ade-pvl-name" data-testid={`provider-tile-name-${descriptor.id}`}>
            {descriptor.label}
          </span>
          {descriptor.preview ? <PreviewChip /> : null}
        </span>
        {facts.map((fact, index) => (
          <span key={index} className="ade-pvl-fact" data-tone={fact.tone} data-whole={fact.whole || undefined} title={fact.text}>{fact.text}</span>
        ))}
      </span>
      <span className="kit-tag ade-pvl-chip" data-tone={chipTone}>
        {chipLabel}
      </span>
    </>
  );

  return (
    <div
      className="ade-pvl-tile"
      data-state={state}
      data-row={row}
      data-static={onOpen ? undefined : "true"}
      data-wrap={wrapFacts || undefined}
      hidden={hidden}
      style={{ "--pvl-accent": accent } as React.CSSProperties}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${descriptor.label} settings`}
          className="ade-pvl-open"
        >
          {body}
        </button>
      ) : (
        <div className="ade-pvl-open" data-static="true">{body}</div>
      )}
      {action?.kind === "button" ? (
        <button
          type="button"
          className="ade-pvl-action"
          aria-label={action.aria}
          aria-busy={action.busy || undefined}
          disabled={action.busy}
          onClick={action.run}
        >
          {action.label}
        </button>
      ) : action?.kind === "switch" ? (
        <span className="ade-pvl-switch">
          <SettingsToggle
            checked={action.checked}
            disabled={action.busy}
            label={action.aria}
            onChange={action.run}
          />
        </span>
      ) : null}
    </div>
  );
}
