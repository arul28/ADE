import React from "react";
import { ChartLineUp } from "@phosphor-icons/react";
import type { ProductAnalyticsStatus } from "../../../shared/types/productAnalytics";
import { ConsentToggleSection } from "./settingsSectionUi";

export function ProductAnalyticsSection() {
  return (
    <ConsentToggleSection<ProductAnalyticsStatus>
      id="product-analytics"
      title="Anonymous product analytics"
      description="Help improve ADE by sharing bounded, anonymous usage events."
      icon={ChartLineUp}
      brandColor="#A78BFA"
      label="Share anonymous usage analytics"
      body="ADE uses a random installation ID plus installation-salted opaque project and session IDs. It sends only allowlisted feature, screen, outcome, version, and aggregate usage counts—never prompts, code, file or terminal content, repository names or paths, command arguments, or recordings."
      footnote={(status) =>
        status?.configured
          ? `Daily safety limit: ${status.dailyBudget} events on this ADE installation.`
          : "Analytics delivery will remain idle until this ADE build is connected to its analytics project."}
      read={() => window.ade.analytics.getStatus()}
      write={(enabled) => window.ade.analytics.setEnabled(enabled)}
      readErrorMessage="Analytics settings are unavailable right now."
      writeErrorMessage="ADE could not save this analytics preference."
    />
  );
}
