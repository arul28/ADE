/**
 * The frame of one integration page: a banner in the maker's colors with the
 * logo standing on it and who this machine is signed in as, then two cards
 * of equal size. GitHub, Linear and Jira each fill it with their own state.
 */
import React, { type ReactNode } from "react";
import { SolidLogo } from "../providers/ProviderHero";
import { SettingsToggle } from "../primitives";
import { integrationBrand, integrationThemeVars, type IntegrationHeroBrand, type IntegrationId } from "./integrationBrand";
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
  const accountPanel = (
    <>
      <span className="ade-ig-hero-panel-label">{account ? "Signed in" : "Account"}</span>
      {account ? (
        <div className="ade-ig-account">
          <span className="ade-ig-avatar" aria-hidden>{account.avatar}</span>
          <div className="ade-ig-account-id">
            <b>{account.title}</b>
            {account.detail ? <span>{account.detail}</span> : null}
          </div>
        </div>
      ) : (
        <p className="ade-ig-hero-panel-empty">
          {accountNote ?? (status.tone === "checking" ? "Checking this machine's sign-in…" : `This machine isn't connected to ${brand.label} yet.`)}
        </p>
      )}
      {actions ? <div className="ade-ig-hero-panel-actions">{actions}</div> : null}
    </>
  );
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
      <div className="ade-ig-hero-row">
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
        <div className="ade-ig-hero-panel">
          {panel ?? accountPanel}
          {topBar && !hasFacts ? toggle : null}
        </div>
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
}) {
  return (
    <section
      className="ade-ig-card"
      id={anchor}
      data-settings-anchor={anchor}
      data-tone={tone}
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
