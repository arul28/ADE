import React from "react";
import { Lifebuoy } from "@phosphor-icons/react";
import type { DiagnosticsSharingStatus } from "../../../shared/types/diagnostics";
import { ConsentToggleSection } from "./settingsSectionUi";

/**
 * The off switch for automatic diagnostic reports.
 *
 * Same shape as the analytics section next to it, and now literally the same
 * component: this is a consent control, so it reads the real persisted state
 * rather than assuming, and it says plainly what gets sent and how often.
 */
export function DiagnosticsSharingSection() {
  const bridge = window.ade?.diagnostics;
  return (
    <ConsentToggleSection<DiagnosticsSharingStatus>
      id="diagnostics-sharing"
      title="Diagnostics sharing"
      description="Send ADE a report when something breaks, so it can be fixed."
      icon={Lifebuoy}
      brandColor="#60A5FA"
      label="Share diagnostics with ADE when something breaks"
      body={'ADE sends the same report the "Report issue" button makes: app and system versions, recent ADE logs, disk space and the failure code. Paths, names, emails and credentials are removed first. Never your code, chats or terminal output.'}
      footnote={(status) =>
        `At most ${status?.limit ?? 3} a day, one per problem. You get a message every time one is sent.`}
      read={bridge ? () => bridge.getSharing() : undefined}
      write={bridge ? (enabled) => bridge.setSharing(enabled) : undefined}
      readErrorMessage="This setting is unavailable right now."
      writeErrorMessage="ADE could not save this setting."
    />
  );
}
