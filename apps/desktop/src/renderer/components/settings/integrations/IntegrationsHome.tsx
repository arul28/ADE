/**
 * Settings › Integrations, before one is opened: a card per integration with
 * the maker's banner, what it does in ADE, and whether this machine is
 * connected to it. A card opens the integration's own page.
 */
import React, { useEffect, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { captureError } from "../../../../shared/sentry/capture";
import { INTEGRATION_IDS, integrationBrand, integrationThemeVars, type IntegrationId } from "./integrationBrand";
import type { IntegrationTone } from "./IntegrationChrome";
import { SolidLogo } from "../providers/ProviderHero";
import "../providers/providerPage.css";
import "./integrationPage.css";

type Summary = { tone: IntegrationTone; label: string };

const CHECKING: Summary = { tone: "checking", label: "Checking…" };
const UNKNOWN: Summary = { tone: "neutral", label: "Couldn't check" };

const DESCRIPTIONS: Record<IntegrationId, string> = {
  github: "Open, review and merge pull requests, follow checks, and work on issues.",
  linear: "Start lanes from Linear issues, link them to PRs, and let your team assign work to ADE.",
  jira: "Bring a Jira Cloud site's issues into ADE and tie them to this project.",
};

async function readSummary(id: IntegrationId, pin: OpenProjectBinding | null): Promise<Summary> {
  if (id === "github") {
    const status = await window.ade.github.getStatus(undefined, pin);
    if (status.connected) return { tone: "ok", label: status.userLogin ? `Connected as ${status.userLogin}` : "Connected" };
    if (status.authFailure || status.credentialStoreUnreadable) return { tone: "warn", label: "Needs attention" };
    return { tone: "neutral", label: "Not connected" };
  }
  if (id === "linear") {
    const cto = window.ade.cto;
    if (!cto) return UNKNOWN;
    const status = await cto.getLinearConnectionStatus(pin);
    if (status.connected) {
      const workspace = status.organizationName?.trim() || status.organizationUrlKey?.trim();
      return { tone: "ok", label: workspace ? `Connected to ${workspace}` : "Connected" };
    }
    return { tone: "neutral", label: "Not connected" };
  }
  const status = await window.ade.jira.getConnectionStatus(pin);
  if (status.error) return { tone: "warn", label: "Needs attention" };
  if (status.connected) {
    const site = status.siteUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return { tone: "ok", label: site ? `Connected to ${site}` : "Connected" };
  }
  return { tone: "neutral", label: "Not connected" };
}

export function IntegrationsHome({
  pin,
  onOpen,
}: {
  /** The page's machine: each status is read where its credential lives. */
  pin: OpenProjectBinding | null;
  onOpen: (id: IntegrationId) => void;
}) {
  const [summaries, setSummaries] = useState<Record<IntegrationId, Summary>>({
    github: CHECKING,
    linear: CHECKING,
    jira: CHECKING,
  });

  useEffect(() => {
    let cancelled = false;
    setSummaries({ github: CHECKING, linear: CHECKING, jira: CHECKING });
    for (const id of INTEGRATION_IDS) {
      readSummary(id, pin)
        .then((summary) => { if (!cancelled) setSummaries((prev) => ({ ...prev, [id]: summary })); })
        .catch((error: unknown) => {
          captureError(error, {
            tags: { feature: "integrations_settings", action: "read_status", integration: id },
            fingerprint: ["integrations_settings", "read_status", id],
            handled: true,
          });
          if (!cancelled) setSummaries((prev) => ({ ...prev, [id]: UNKNOWN }));
        });
    }
    return () => { cancelled = true; };
    // A rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key]);

  return (
    <div className="ade-ig-home">
      <div className="ade-ig-grid">
        {INTEGRATION_IDS.map((id) => {
          const brand = integrationBrand(id);
          const summary = summaries[id];
          return (
            <button
              key={id}
              type="button"
              className="ade-ig-tile"
              style={integrationThemeVars(brand)}
              data-testid={`integration-tile-${id}`}
              onClick={() => onOpen(id)}
            >
              <span className="ade-ig-tile-banner" style={brand.banner} aria-hidden>
                <img src={brand.art} alt="" draggable={false} />
                <SolidLogo spec={brand.logo} straight />
              </span>
              <span className="ade-ig-tile-body">
                <span className="ade-ig-tile-name">
                  {brand.label}
                  <CaretRight size={13} weight="bold" />
                </span>
                <span className="ade-ig-tile-desc">{DESCRIPTIONS[id]}</span>
                <span className="ade-ig-tile-status">
                  <i className="ade-ig-dot" data-tone={summary.tone} />
                  <span>{summary.label}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
