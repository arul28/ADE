/**
 * The top of a provider page: the maker's banner, the logo standing on it in
 * 3D, the provider's name and state, and what the user ran on it across
 * every machine on their ADE account in the last 30 days.
 */
import React, { cloneElement, isValidElement, useEffect, useMemo, useState, type CSSProperties, type ReactNode, type SVGProps } from "react";
import type { AdeUsageStats } from "../../../../shared/types/usage";
import type { OpenProjectBinding } from "../../../../shared/types";
import { formatCost, formatTokens } from "../../../lib/format";
import { providerBrand, type ProviderBrandLogo } from "./providerBrand";
import { providerStatusColor } from "./providerUi";
import type { ProviderDescriptor, ProviderStatusState } from "./types";
import "./providerPage.css";

type HeroUsage = {
  tokens: number;
  costUsd: number;
  /**
   * Null when the stats counted no requests. Provider-ledger model rows carry
   * tokens and dollars but no request count (`calls` stays 0), so a sum of
   * them read "0 requests" beside billions of tokens.
   */
  requests: number | null;
  models: Array<{ id: string; label: string; tokens: number }>;
};

/** This provider's slice of the account's 30-day usage, or null when it ran nothing. */
function usageFor(stats: AdeUsageStats, providerId: string, labelFor: (id: string) => string): HeroUsage | null {
  const provider = stats.providers.find((row) => row.provider === providerId);
  const models = stats.models
    .filter((row) => row.provider === providerId && row.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens);
  if (!provider || provider.totalTokens <= 0) return null;
  const requests = models.reduce((sum, row) => sum + row.calls, 0);
  return {
    tokens: provider.totalTokens,
    costUsd: provider.rangeCostUsd,
    requests: requests > 0 ? requests : null,
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
    // A stat about the user is every machine's, never just the one showing
    // the page. Account scope answers from stored rollups at once and
    // refreshes the other machines in the background.
    read({ preset: "30d", scope: "account" }, pin)
      .then((next) => { if (!cancelled) setStats(next ?? null); })
      .catch(() => { if (!cancelled) setStats(null); });
    return () => { cancelled = true; };
    // A rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, pin?.key]);
  // Loading or unreadable stats show no panel: "no chats ran" is only for a read that worked.
  // The reach is the response's, kept apart from the figures: an older host
  // that answered for one machine with nothing for this provider still says so.
  return useMemo(
    () => (stats ? { usage: usageFor(stats, providerId, labelFor), allMachines: stats.scope === "account" } : undefined),
    [stats, providerId, labelFor],
  );
}

const SOLID_DEPTH = 10;

/**
 * A logo that stands as a solid object. `straight` faces it square to the
 * viewer with its depth falling straight down (the integration pages); the
 * provider pages turn it a little.
 */
export function SolidLogo({ spec, straight = false, floor = false }: {
  spec: Extract<ProviderBrandLogo, { kind: "solid" }>;
  straight?: boolean;
  /** The shadow it casts under it, for a hero-sized logo. Tiles and cards go without. */
  floor?: boolean;
}) {
  const size = spec.size ?? 84;
  // A straight mark is seen from the front: a thin edge, in proportion to the
  // mark. A fixed depth would make a small mark look tall and tipped back.
  const straightEdge = SOLID_DEPTH * 0.45 * (size / 84);
  // That edge is a pixel or two at tile sizes, and one copy per half pixel
  // draws it as solid as ten: a grid of tiles stays a few thousand elements.
  const count = straight ? Math.min(SOLID_DEPTH, Math.max(2, Math.ceil(straightEdge / 0.5))) : SOLID_DEPTH;
  const straightStep = straightEdge / count;
  const layers = Array.from({ length: count }, (_, index) => count - index);
  return (
    <div className="ade-pv-mark3d" data-straight={straight ? "true" : undefined} aria-hidden>
      {floor ? <div className="ade-pv-mark3d-floor" /> : null}
      <div className="ade-pv-mark3d-body">
        {layers.map((depth) => (
          <SolidLayer
            key={depth}
            mark={spec.mark(size)}
            style={{
              transform: straight ? `translateY(${depth * straightStep}px)` : `translate(${depth * 0.8}px, ${depth * 1}px)`,
              // The far layers are darker, so the side reads as lit from the front.
              ...(spec.fullColor
                ? { filter: `brightness(${0.32 + (SOLID_DEPTH - depth * (SOLID_DEPTH / count)) * 0.035}) saturate(1.3)` }
                : { color: spec.side, filter: `brightness(${0.7 + (SOLID_DEPTH - depth * (SOLID_DEPTH / count)) * 0.04})` }),
            }}
          />
        ))}
        <SolidLayer mark={spec.mark(size)} part="face" style={spec.face ? { color: spec.face } : undefined} />
        <SolidLayer mark={spec.mark(size)} part="gloss" />
      </div>
    </div>
  );
}

/**
 * One copy of the mark. A plain `<svg>` mark is the layer itself; any other
 * mark (a component) sits in a span. A grid of tiles draws five copies per
 * logo, so the span it saves is about a sixth of the Integrations page.
 */
function SolidLayer({ mark, part, style }: { mark: ReactNode; part?: "face" | "gloss"; style?: CSSProperties }) {
  const layer = {
    className: "ade-pv-mark3d-layer",
    "data-face": part === "face" ? "true" : undefined,
    "data-gloss": part === "gloss" ? "true" : undefined,
  };
  if (isValidElement<SVGProps<SVGSVGElement>>(mark) && mark.type === "svg") {
    const className = [mark.props.className, layer.className].filter(Boolean).join(" ");
    return cloneElement(mark, { ...layer, className, style: { ...mark.props.style, ...style } });
  }
  return <span {...layer} style={style}>{mark}</span>;
}

function ProviderLogo3d({ descriptor }: { descriptor: ProviderDescriptor }) {
  const logo = providerBrand(descriptor.id).logo;
  if (logo.kind === "solid") return <SolidLogo spec={logo} floor />;
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
  tagline = descriptor.tagline,
  accountUsageOnly = false,
}: {
  descriptor: ProviderDescriptor;
  status: { state: ProviderStatusState; label: string; account?: string | null };
  version: string | null;
  pin: OpenProjectBinding | null;
  modelLabel: (id: string) => string;
  /** The line under the name; null shows none. The descriptor's line describes a computer's own sign-in. */
  tagline?: string | null;
  /**
   * The usage panel shows only when its figures add up every computer of the
   * account, and says so. For a place that is not one computer (ADE Cloud):
   * one computer's figures would not be about it.
   */
  accountUsageOnly?: boolean;
}) {
  const brand = providerBrand(descriptor.id);
  const read = useProviderUsage(descriptor.id, pin, modelLabel);
  const hero = accountUsageOnly && read && !read.allMachines ? undefined : read;
  const usage = hero?.usage ?? null;
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
          {tagline ? <div className="ade-pv-hero-tagline">{tagline}</div> : null}
          <div className="ade-pv-hero-chips">
            <span className="ade-pv-hero-chip">
              <i style={{ background: providerStatusColor(status.state) }} />
              {status.label}
            </span>
            {status.account ? <span className="ade-pv-hero-chip">{status.account}</span> : null}
            {version ? <span className="ade-pv-hero-chip">v{version}</span> : null}
            {descriptor.preview ? <span className="ade-pv-hero-chip">Preview</span> : null}
          </div>
        </div>
        {hero === undefined ? null : (
          <div className="ade-pv-hero-stats">
            <div className="ade-pv-hero-stats-head">
              <span>{accountUsageOnly ? "Chats on all your computers" : hero.allMachines ? "All machines" : "One machine"}</span>
              <span>30 days</span>
            </div>
            {usage ? (
              <>
                <div className="ade-pv-hero-figures">
                  <div className="ade-pv-hero-figure">
                    <b>{formatTokens(usage.tokens)}</b>
                    <span>tokens</span>
                  </div>
                  {usage.requests != null ? (
                    <div className="ade-pv-hero-figure">
                      <b>{usage.requests.toLocaleString("en-US")}</b>
                      <span>requests</span>
                    </div>
                  ) : null}
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
              <div className="ade-pv-hero-empty">
                {accountUsageOnly
                  ? `No chats ran on ${descriptor.label} on any of your computers in the last 30 days.`
                  : `No chats ran on ${descriptor.label} on your machines in the last 30 days.`}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
