/**
 * The frame of one integration page: a banner in the maker's colors with the
 * logo standing on it and who this machine is signed in as, then two cards
 * of equal size. GitHub, Linear and Jira each fill it with their own state.
 */
import React, { type ReactNode } from "react";
import { SolidLogo } from "../providers/ProviderHero";
import { SettingsToggle } from "../primitives";
import { integrationBrand, integrationThemeVars, type IntegrationHeroBrand, type IntegrationId } from "./integrationBrand";
import type { IntegrationCredentialStorage } from "../../../../shared/types/integrationCredentialStorage";
import "../providers/providerPage.css";
import "./integrationPage.css";

/**
 * Colour carries status only: ok, needs attention, broken, nothing to say,
 * switched off, or not known yet.
 */
export type IntegrationTone = "ok" | "warn" | "crit" | "neutral" | "off" | "checking";

export type IntegrationFact = {
  label: string;
  value: ReactNode;
  /** Shown on hover, for a value that needs a word of explanation. */
  title?: string;
  tone?: "warn";
  mono?: boolean;
};

/** The "Saved" fact: whether this credential follows the person to their other machines. */
export function credentialStorageFact(storage: IntegrationCredentialStorage | null | undefined): IntegrationFact | null {
  if (!storage) return null;
  return storage.storage === "account"
    ? { label: "Saved", value: "All your machines", title: "Your ADE account carries this credential to your other machines for this project." }
    : { label: "Saved", value: "This computer only", tone: "warn", title: storage.message?.trim() || "This credential stays on this computer." };
}

export function IntegrationPage({ id, children }: { id: IntegrationId; children: ReactNode }) {
  return (
    <div className="ade-pv-provider ade-ig-page" data-integration={id} style={integrationThemeVars(integrationBrand(id).accent)}>
      {children}
    </div>
  );
}

export type IntegrationAccount = {
  /** A picture or an initial. */
  avatar: ReactNode;
  /** Who or what this machine is signed in to. */
  title: ReactNode;
  /** One quiet line: how, or where. */
  detail?: ReactNode;
};

/**
 * The top of an integration page. Left: the logo standing on the maker's
 * banner, the name and the state. Right: who this machine is signed in as,
 * with the page's main actions. Along the bottom: the few facts worth a
 * glance, and the top-bar switch.
 *
 * GitHub, Linear and Jira pass their `id`. A page of ADE's own passes its
 * `brand`, its own `art` and its own `panel` instead.
 */
export function IntegrationHero({
  anchor,
  status,
  account = null,
  accountNote,
  actions,
  facts,
  topBar,
  art,
  panel,
  className,
  group,
  footer,
  ...source
}: ({ id: IntegrationId; brand?: never } | { brand: IntegrationHeroBrand; id?: never }) & {
  /** The settings deeplink target, when the connection lives in the banner. */
  anchor?: string;
  status: { tone: IntegrationTone; label: string };
  /** Null while not connected: the panel then says so. */
  account?: IntegrationAccount | null;
  /** What the panel says with no account, when "not connected yet" would be wrong. */
  accountNote?: string;
  /** Under the account (Check again, Disconnect). */
  actions?: ReactNode;
  facts?: IntegrationFact[];
  /** The switch for this integration's button in ADE's top bar. */
  topBar?: { label: string; checked: boolean; onChange: (next: boolean) => void; anchor?: string };
  /** Drawn behind the row in place of the maker's banner picture. */
  art?: ReactNode;
  /** The right-hand panel's contents, in place of the account. */
  panel?: ReactNode;
  className?: string;
  /** The settings search group the banner belongs to. */
  group?: string;
  /** One line under the facts, inside the banner: a state the page wants seen first. */
  footer?: ReactNode;
}) {
  const brand: IntegrationHeroBrand = source.brand ?? integrationBrand(source.id);
  const picture = source.id ? integrationBrand(source.id).art : null;
  // With nothing connected there are no facts, so the switch joins the panel
  // rather than sitting alone in an empty strip.
  const hasFacts = Boolean(facts?.length);
  const toggle = topBar ? (
    <div className="ade-ig-hero-toggle" id={topBar.anchor} data-settings-anchor={topBar.anchor}>
      <span>
        <b>Top bar</b>
        <small>{topBar.label}</small>
      </span>
      <SettingsToggle label={`Show ${topBar.label} in the top bar`} checked={topBar.checked} onChange={topBar.onChange} />
    </div>
  ) : null;
  // Not connected says itself in the status chip, so the panel then carries
  // only what it has to: a note that isn't "not connected", the actions, the
  // switch. With none of those there is no panel at all.
  const emptyNote = account ? null : accountNote ?? (status.tone === "checking" ? "Checking the connection…" : null);
  const accountPanel = account || emptyNote || actions ? (
    <>
      {account ? (
        <>
          <span className="ade-ig-hero-panel-label">Signed in</span>
          <div className="ade-ig-account">
            <span className="ade-ig-avatar" aria-hidden>{account.avatar}</span>
            <div className="ade-ig-account-id">
              <b>{account.title}</b>
              {account.detail ? <span>{account.detail}</span> : null}
            </div>
          </div>
        </>
      ) : emptyNote ? (
        <p className="ade-ig-hero-panel-empty">{emptyNote}</p>
      ) : null}
      {actions ? <div className="ade-ig-hero-panel-actions">{actions}</div> : null}
    </>
  ) : null;
  const panelContent = panel ?? accountPanel;
  const showPanel = panelContent != null || (topBar != null && !hasFacts);
  return (
    <section
      className={className ? `ade-ig-hero ${className}` : "ade-ig-hero"}
      id={anchor}
      data-settings-anchor={anchor}
      data-settings-group={group}
      data-light={brand.lightBanner ? "true" : undefined}
      style={brand.banner}
    >
      {art ?? (picture ? <img className="ade-ig-hero-art" src={picture} alt="" draggable={false} /> : null)}
      <div className="ade-ig-hero-shade" />
      <div className="ade-ig-hero-row" data-panel={showPanel ? undefined : "none"}>
        <SolidLogo spec={brand.logo} straight />
        <div className="ade-ig-hero-id">
          <h1 className="ade-ig-hero-name">{brand.label}</h1>
          <p className="ade-ig-hero-tagline">{brand.tagline}</p>
          <div className="ade-ig-hero-chips">
            <span className="ade-ig-chip" data-tone={status.tone} role="status">
              <i />
              {status.label}
            </span>
          </div>
        </div>
        {showPanel ? (
          <div className="ade-ig-hero-panel">
            {panelContent}
            {topBar && !hasFacts ? toggle : null}
          </div>
        ) : null}
      </div>
      {hasFacts ? (
        <div className="ade-ig-hero-strip">
          {facts?.map((fact) => (
            <div key={fact.label} className="ade-ig-hero-fact" title={fact.title}>
              <span>{fact.label}</span>
              <b data-tone={fact.tone} data-mono={fact.mono ? "true" : undefined}>{fact.value}</b>
            </div>
          ))}
          {topBar && hasFacts ? toggle : null}
        </div>
      ) : null}
      {footer ? <div className="ade-ig-hero-foot">{footer}</div> : null}
    </section>
  );
}

/**
 * One card on an integration page. `anchor` is the settings deeplink target:
 * search results and `ade://settings/…` links scroll to it.
 */
export function IntegrationCard({
  anchor,
  icon,
  title,
  hint,
  badge,
  actions,
  children,
  tone,
  span,
}: {
  anchor?: string;
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
  /** A status tag beside the title. */
  badge?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** A card that is waiting on the user (a sign-in to finish) draws in the accent. */
  tone?: "focus";
  /** `full`: the card takes the whole row of the page body (a rich card under two small ones). */
  span?: "full";
}) {
  return (
    <section
      className="ade-ig-card"
      id={anchor}
      data-settings-anchor={anchor}
      data-tone={tone}
      data-span={span}
    >
      <header className="ade-ig-card-head">
        <span className="ade-ig-card-icon" aria-hidden>{icon}</span>
        <div className="ade-ig-card-title">
          <div className="ade-ig-card-title-row">
            <h2>{title}</h2>
            {badge}
          </div>
          {hint ? <p>{hint}</p> : null}
        </div>
        {actions ? <div className="ade-ig-card-actions">{actions}</div> : null}
      </header>
      {children ? <div className="ade-ig-card-body">{children}</div> : null}
    </section>
  );
}

/** A divider with a word in the middle: "or". */
export function IntegrationOr({ children }: { children: ReactNode }) {
  return <div className="ade-ig-or"><span>{children}</span></div>;
}

/** The page body: two cards of equal width and height, or one across. */
export function IntegrationColumns({ children }: { children: ReactNode }) {
  return <div className="ade-ig-body">{children}</div>;
}

/**
 * A segmented choice (`.kit-seg`) exposed as a radio group. `sentenceCase`
 * off keeps the kit's small-caps look, for short values like counts.
 */
export function IntegrationChoice<T extends string | number>({ label, value, options, disabled, sentenceCase = true, onChange }: {
  label: string;
  value: T | null;
  options: readonly { value: T; label: string; title?: string }[];
  disabled: boolean;
  sentenceCase?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="kit-seg" data-case={sentenceCase ? "sentence" : undefined} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          disabled={disabled}
          onClick={() => { if (option.value !== value) onChange(option.value); }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
