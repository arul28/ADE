/**
 * The top of a provider page: the maker's banner, the logo standing on it in
 * 3D, the provider's name and state, and what this machine ran on it in
 * the last 30 days.
 */
import React, { useEffect, useMemo, useState } from "react";
import type { AdeUsageStats } from "../../../../shared/types/usage";
import type { OpenProjectBinding } from "../../../../shared/types";
import { formatCost, formatTokens } from "../../../lib/format";
import { providerBrand, type ProviderBrandLogo } from "./providerBrand";
import { providerStatusColor } from "./providerUi";
import type { ProviderDescriptor, ProviderStatusState } from "./types";

type HeroUsage = {
  tokens: number;
  costUsd: number;
  requests: number;
  models: Array<{ id: string; label: string; tokens: number }>;
};

/** This provider's slice of the machine's 30-day usage, or null when it ran nothing. */
function usageFor(stats: AdeUsageStats, providerId: string, labelFor: (id: string) => string): HeroUsage | null {
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
    // A host without usage stats (an older preload) shows the banner without its panel.
    const read = window.ade.usage?.getAdeStats;
    if (typeof read !== "function") {
      setStats(null);
      return;
    }
    read({ preset: "30d", scope: "machine" }, pin)
      .then((next) => { if (!cancelled) setStats(next ?? null); })
      .catch(() => { if (!cancelled) setStats(null); });
    return () => { cancelled = true; };
    // A rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, pin?.key]);
  // Loading or unreadable stats show no panel: "no chats ran" is only for a read that worked.
  return useMemo(
    () => (stats ? usageFor(stats, providerId, labelFor) : undefined),
    [stats, providerId, labelFor],
  );
}

const SOLID_DEPTH = 10;

function SolidLogo({ spec }: { spec: Extract<ProviderBrandLogo, { kind: "solid" }> }) {
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

function ProviderLogo3d({ descriptor }: { descriptor: ProviderDescriptor }) {
  const logo = providerBrand(descriptor.id).logo;
  if (logo.kind === "solid") return <SolidLogo spec={logo} />;
  return (
    <div className="ade-pv-logo3d" aria-hidden>
      <div className="ade-pv-logo3d-face" style={{ background: logo.background, color: logo.color }}>
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
        <ProviderLogo3d descriptor={descriptor} />
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
