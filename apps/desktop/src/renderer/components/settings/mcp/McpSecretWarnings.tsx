import React from "react";
import { Warning } from "@phosphor-icons/react";
import { mcpPlainTextSecretFindings, type McpPlainTextSecretFinding } from "../../../../shared/mcpServerImport";

/**
 * "This looks like a secret, and it is in the part that syncs as plain text."
 *
 * Env and header values go to the account vault. Arguments and the URL are
 * part of the list itself, so a token placed there is stored readable. The
 * check is a guess from the text's shape; it warns and never blocks.
 */

function sentence(finding: McpPlainTextSecretFinding, transport: "stdio" | "http" | "sse"): string {
  if (finding.kind === "reference") {
    return `ADE does not fill in ${finding.reference ?? "${...}"}. The server gets that text as written.`;
  }
  if (finding.where === "url") {
    return "This URL looks like it holds a secret. The URL is saved as plain text and syncs to your account. Put the secret in a header instead.";
  }
  return transport === "stdio"
    ? "An argument looks like it holds a secret. Arguments are saved as plain text and sync to your account. Put the secret in an environment variable instead."
    : "An argument looks like it holds a secret. Arguments are saved as plain text and sync to your account.";
}

/** The warning lines for one server, or nothing when its arguments and URL look clean. */
export function McpSecretWarnings({
  server,
  where,
}: {
  server: { transport: "stdio" | "http" | "sse"; args?: readonly string[]; url?: string };
  /** Limit to one field, for a form that shows each warning under its own box. */
  where?: McpPlainTextSecretFinding["where"];
}) {
  const findings = mcpPlainTextSecretFindings(server).filter((finding) => !where || finding.where === where);
  if (findings.length === 0) return null;
  return (
    <div className="ade-modern-note" data-tone="warn" data-mcp-plain-secret="">
      <Warning size={14} weight="fill" />
      <div className="ade-modern-note-body">
        {findings.map((finding) => (
          <span key={`${finding.where}:${finding.kind}`}>{sentence(finding, server.transport)}</span>
        ))}
      </div>
    </div>
  );
}

/** True when a server's arguments or URL look like they hold a secret itself. */
export function mcpServerHoldsPlainSecret(server: { args?: readonly string[]; url?: string }): boolean {
  return mcpPlainTextSecretFindings(server).some((finding) => finding.kind === "value");
}
