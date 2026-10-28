/**
 * The top of a provider page: the maker's banner, the logo standing on it as a
 * 3D tile, the provider's name and state, and what this machine ran on it in
 * the last 30 days.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Antigravity, Claude, Codex, Cursor, GithubCopilot, Grok, Kimi, Qwen } from "@lobehub/icons";
import type { AdeUsageStats } from "../../../../shared/types/usage";
import type { OpenProjectBinding } from "../../../../shared/types";
import { formatCost, formatTokens } from "../../../lib/format";
import { DevinMark, MuseLogo } from "../../shared/ProviderLogos";
import { providerBrand } from "./providerBrand";
import { providerStatusColor } from "./providerUi";
import type { ProviderDescriptor, ProviderStatusState } from "./types";

type HeroUsage = {
  tokens: number;
  costUsd: number;
  requests: number;
  models: Array<{ id: string; label: string; tokens: number }>;
};

/** This provider's slice of the machine's 30-day usage, or null when it ran nothing. */
function usageFor(stats: AdeUsageStats | null, providerId: string, labelFor: (id: string) => string): HeroUsage | null {
  if (!stats) return null;
  const provider = stats.providers.find((row) => row.provider === providerId);
  const models = stats.models
    .filter((row) => row.provider === providerId && row.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens);
  if (!provider || provider.totalTokens <= 0) return null;
  return {
    tokens: provider.totalTokens,
    costUsd: provider.rangeCostUsd,
    requests: models.reduce((sum, row) => sum + row.calls, 0),
    models: models.slice(0, 3).map((row) => ({ id: row.model, label: labelFor(row.model), tokens: row.totalTokens })),
  };
}

function useProviderUsage(providerId: string, pin: OpenProjectBinding | null, labelFor: (id: string) => string) {
  const [stats, setStats] = useState<AdeUsageStats | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setStats(undefined);
    window.ade.usage
      .getAdeStats({ preset: "30d", scope: "machine" }, pin)
      .then((next) => { if (!cancelled) setStats(next ?? null); })
      .catch(() => { if (!cancelled) setStats(null); });
    return () => { cancelled = true; };
    // A rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, pin?.key]);
  return useMemo(
    () => (stats === undefined ? undefined : usageFor(stats, providerId, labelFor)),
    [stats, providerId, labelFor],
  );
}

/**
 * A logo with a shape of its own stands on the banner as a solid object: the
 * mark is stacked in depth, its side in a dark shade of the maker's color.
 * A one-color mark takes `face` and `side` as its ink. A full-color mark keeps
 * its colors and darkens them for the side (`side` is then unused).
 */
type SolidMark = {
  mark: (size: number) => React.ReactNode;
  face?: string;
  side: string;
  fullColor?: boolean;
  size?: number;
};

const SOLID_MARKS: Record<string, SolidMark> = {
  claude: { mark: (size) => <Claude size={size} />, face: "#FFF4EA", side: "#9C3E1C" },
  codex: { mark: (size) => <Codex size={size} />, face: "#FFFFFF", side: "#1F2A9C" },
  cursor: { mark: (size) => <Cursor size={size} />, face: "#F4F4F5", side: "#3A3A42" },
  copilot: { mark: (size) => <GithubCopilot size={size} />, face: "#FFFFFF", side: "#2A0C8F" },
  muse: { mark: (size) => <MuseLogo size={size} />, side: "", fullColor: true, size: 104 },
  qwen: { mark: (size) => <Qwen size={size} />, face: "#FFFFFF", side: "#231C8C" },
  kimi: { mark: (size) => <Kimi size={size} />, face: "#FFFFFF", side: "#0E4C9E" },
  grok: { mark: (size) => <Grok size={size} />, face: "#FFFFFF", side: "#45454A" },
  devin: { mark: (size) => <DevinMark size={size} />, face: "#F2F2F2", side: "#3C3C40", size: 108 },
  antigravity: { mark: (size) => <Antigravity.Color size={size} />, side: "", fullColor: true },
};

const SOLID_DEPTH = 10;

function SolidLogo({ spec }: { spec: SolidMark }) {
  const size = spec.size ?? 84;
  const layers = Array.from({ length: SOLID_DEPTH }, (_, index) => SOLID_DEPTH - index);
  return (
    <div className="ade-pv-mark3d" aria-hidden>
      <div className="ade-pv-mark3d-floor" />
      <div className="ade-pv-mark3d-body">
        {layers.map((depth) => (
          <span
            key={depth}
            className="ade-pv-mark3d-layer"
            style={{
              transform: `translate(${depth * 0.8}px, ${depth * 1}px)`,
              // The far layers are darker, so the side reads as lit from the front.
              ...(spec.fullColor
                ? { filter: `brightness(${0.32 + (SOLID_DEPTH - depth) * 0.035}) saturate(1.3)` }
                : { color: spec.side, filter: `brightness(${0.7 + (SOLID_DEPTH - depth) * 0.04})` }),
            }}
          >
            {spec.mark(size)}
          </span>
        ))}
        <span className="ade-pv-mark3d-layer" data-face="true" style={spec.face ? { color: spec.face } : undefined}>
          {spec.mark(size)}
        </span>
        <span className="ade-pv-mark3d-layer" data-gloss="true">
          {spec.mark(size)}
        </span>
      </div>
    </div>
  );
}

/** A square mark (Droid, Pi, OpenCode) keeps its tile: the tile is the logo's own shape. */
export function ProviderLogoTile({ descriptor }: { descriptor: ProviderDescriptor }) {
  const solid = SOLID_MARKS[descriptor.id];
  if (solid) return <SolidLogo spec={solid} />;
  const brand = providerBrand(descriptor.id);
  return (
    <div className="ade-pv-logo3d" aria-hidden>
      <div className="ade-pv-logo3d-face" style={{ background: brand.tile.background, color: brand.tile.color }}>
        {descriptor.logo(58)}
      </div>
    </div>
  );
}

export function ProviderHero({
  descriptor,
  status,
  version,
  pin,
  modelLabel,
}: {
  descriptor: ProviderDescriptor;
  status: { state: ProviderStatusState; label: string };
  version: string | null;
  pin: OpenProjectBinding | null;
  modelLabel: (id: string) => string;
}) {
  const brand = providerBrand(descriptor.id);
  const usage = useProviderUsage(descriptor.id, pin, modelLabel);
  const topTokens = usage?.models[0]?.tokens ?? 0;

  return (
    <section
      className="ade-pv-hero"
      data-light={brand.lightBanner ? "true" : undefined}
      data-shade={brand.softShade ? "soft" : undefined}
      style={brand.banner}
    >
      <div className="ade-pv-hero-shade" />
      {brand.bannerArt ? (
        <img
          className="ade-pv-hero-art"
          src={brand.bannerArt.src}
          width={brand.bannerArt.width}
          data-wide={brand.bannerArt.width > 160 ? "true" : undefined}
          style={brand.bannerArt.opacity != null ? { opacity: brand.bannerArt.opacity } : undefined}
          alt=""
          draggable={false}
        />
      ) : null}
      <div className="ade-pv-hero-row">
        <ProviderLogoTile descriptor={descriptor} />
        <div className="ade-pv-hero-id">
          <div className="ade-pv-hero-name">{descriptor.label}</div>
          {descriptor.tagline ? <div className="ade-pv-hero-tagline">{descriptor.tagline}</div> : null}
          <div className="ade-pv-hero-chips">
            <span className="ade-pv-hero-chip">
              <i style={{ background: providerStatusColor(status.state) }} />
              {status.label}
            </span>
            {version ? <span className="ade-pv-hero-chip">v{version}</span> : null}
            {descriptor.preview ? <span className="ade-pv-hero-chip">Preview</span> : null}
          </div>
        </div>
        {usage === undefined ? null : (
          <div className="ade-pv-hero-stats">
            <div className="ade-pv-hero-stats-head">
              <span>On this machine</span>
              <span>30 days</span>
            </div>
            {usage ? (
              <>
                <div className="ade-pv-hero-figures">
                  <div className="ade-pv-hero-figure">
                    <b>{formatTokens(usage.tokens)}</b>
                    <span>tokens</span>
                  </div>
                  <div className="ade-pv-hero-figure">
                    <b>{usage.requests.toLocaleString("en-US")}</b>
                    <span>requests</span>
                  </div>
                  <div className="ade-pv-hero-figure" title="The turns at public list prices">
                    <b>{formatCost(usage.costUsd)}</b>
                    <span>at list price</span>
                  </div>
                </div>
                {usage.models.length ? (
                  <div className="ade-pv-hero-models">
                    {usage.models.map((model) => (
                      <div key={model.id} className="ade-pv-hero-model">
                        <span>{model.label}</span>
                        <span>{formatTokens(model.tokens)}</span>
                        <div className="ade-pv-hero-model-bar">
                          <i style={{ width: `${Math.max(4, Math.round((model.tokens / Math.max(1, topTokens)) * 100))}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="ade-pv-hero-empty">No chats ran on {descriptor.label} here in the last 30 days.</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
