import React, { type CSSProperties, type ReactNode } from "react";
import type { HarnessPresetBody, HarnessPresetLogo } from "../../../../shared/harnessPresets";
import { harnessBodyLabel } from "../../../../shared/harnessPresets";
import type { ProviderFamily } from "../../../../shared/modelRegistry";
import { CustomToolMark } from "../../shared/CustomToolMark";
import { HarnessLogo } from "../../shared/HarnessLogo";
import { ModelRowLogo, ProviderLogo } from "../../shared/ProviderLogos";
import { paletteFromTint, rgbCss } from "../../account/useProfilePalette";
import { bodyLogoFamily } from "./presetFacts";

/**
 * The Custom banner: the provider pages' and Account page's banner, painted
 * from one colour. The section uses it for its empty state and the editor for
 * a live preview of what is being built.
 */

/** The banner's colour stops, as the CSS variables `customProviders.css` reads. */
export function customBannerStyle(color: string): CSSProperties {
  const [base, deep, mid, bright, light] = paletteFromTint(color).ramp;
  return {
    "--cp-base": rgbCss(base!),
    "--cp-deep": rgbCss(deep!),
    "--cp-mid": rgbCss(mid!),
    "--cp-bright": rgbCss(bright!),
    "--cp-light": rgbCss(light!),
    "--cp-accent": color,
  } as CSSProperties;
}

export function CustomBanner({
  color,
  children,
  label,
}: {
  color: string;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section className="ade-cp-banner" style={customBannerStyle(color)} aria-label={label}>
      <div className="ade-cp-banner-wash" />
      <div className="ade-cp-banner-shade" />
      <div className="ade-cp-banner-row">{children}</div>
    </section>
  );
}

/**
 * A preset's mark standing on the banner as a raised glass tile. The default
 * mark draws white here: in the accent it would vanish into its own banner.
 */
export function CustomBannerMark({ logo }: { logo: HarnessPresetLogo }) {
  return (
    <div className="ade-cp-mark" aria-hidden>
      <div className="ade-cp-mark-face">
        {logo.kind === "ade" ? <CustomToolMark size={40} color="#ffffff" /> : <HarnessLogo logo={logo} size={40} />}
      </div>
    </div>
  );
}

export type RecipeModel = {
  label: string;
  id: string;
  family: ProviderFamily | null;
};

export type RecipeSource = {
  /** "ChatGPT Plus", "Claude", "OpenCode Go", "API key · Work". */
  title: string;
  /** The account's email, or how it connects. */
  detail?: string | null;
  logoProvider: string;
};

/**
 * Three facts that make a custom provider, in the order people ask them:
 * which app runs it, which model it thinks with, and whose plan pays.
 */
export function RecipeCard({
  harness,
  model,
  source,
  note,
}: {
  harness: HarnessPresetBody;
  model: RecipeModel | null;
  source: RecipeSource | null;
  note?: ReactNode;
}) {
  return (
    <div className="ade-cp-recipe" data-custom-recipe="">
      <div className="ade-cp-recipe-row">
        <span className="ade-cp-recipe-key">Harness</span>
        <span className="ade-cp-recipe-logo"><ProviderLogo family={bodyLogoFamily(harness)} size={14} /></span>
        <span className="ade-cp-recipe-value">{harnessBodyLabel(harness)}</span>
      </div>
      <div className="ade-cp-recipe-row">
        <span className="ade-cp-recipe-key">Model</span>
        <span className="ade-cp-recipe-logo">
          {model?.family ? <ModelRowLogo modelFamily={model.family} modelId={model.id} size={14} /> : null}
        </span>
        <span className="ade-cp-recipe-value" data-empty={model ? undefined : "true"}>
          {model ? model.label : "Pick one below"}
        </span>
      </div>
      <div className="ade-cp-recipe-row">
        <span className="ade-cp-recipe-key">Uses</span>
        <span className="ade-cp-recipe-logo">
          {source ? <ProviderLogo family={source.logoProvider} size={14} /> : null}
        </span>
        <span
          className="ade-cp-recipe-value"
          data-empty={source ? undefined : "true"}
          title={source?.detail ? `${source.title} · ${source.detail}` : source?.title}
        >
          {source ? source.title : "Your sign-in or key"}
          {source?.detail ? <span style={{ fontWeight: 400, opacity: 0.72 }}>{` · ${source.detail}`}</span> : null}
        </span>
      </div>
      {note ? <div className="ade-cp-recipe-note">{note}</div> : null}
    </div>
  );
}

/** The empty section's picture: a harness, plus a model, makes yours. */
export function CustomEquation() {
  return (
    <div className="ade-cp-equation" aria-hidden>
      <span className="ade-cp-equation-tile"><ProviderLogo family="claude" size={24} /></span>
      <span className="ade-cp-equation-op">+</span>
      <span className="ade-cp-equation-tile"><ProviderLogo family="openai" size={24} /></span>
      <span className="ade-cp-equation-op">=</span>
      <span className="ade-cp-equation-tile" data-glass="true">
        <CustomToolMark size={26} color="#ffffff" />
      </span>
    </div>
  );
}
