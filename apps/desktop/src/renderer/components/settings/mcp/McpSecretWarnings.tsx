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

/**
 * The same findings as one short line, for a server's row in the list: what
 * looks wrong and what to do about it. The full sentences are in the dialog
 * the row's Edit button opens.
 */
function compactSentence(findings: readonly McpPlainTextSecretFinding[], transport: "stdio" | "http" | "sse"): string {
  const secrets = findings.filter((finding) => finding.kind === "value");
  // Nothing that looks like a secret: what is left is a `${NAME}` ADE will not fill in.
  if (secrets.length === 0) return sentence(findings[0]!, transport);
  const inArgs = secrets.some((finding) => finding.where === "args");
  const inUrl = secrets.some((finding) => finding.where === "url");
  if (inArgs && inUrl) return "Its arguments and URL look like they hold a secret, and both sync as plain text. Edit this server to move it.";
  if (inUrl) return "Its URL looks like it holds a secret, and the URL syncs as plain text. Edit this server to move it to a header.";
  return transport === "stdio"
    ? "An argument looks like it holds a secret, and arguments sync as plain text. Edit this server to move it to an environment variable."
    : "An argument looks like it holds a secret, and arguments sync as plain text. Edit this server to move it.";
}

/** The warning lines for one server, or nothing when its arguments and URL look clean. */
export function McpSecretWarnings({
  server,
  where,
  compact = false,
}: {
  server: { transport: "stdio" | "http" | "sse"; args?: readonly string[]; url?: string };
  /** Limit to one field, for a form that shows each warning under its own box. */
  where?: McpPlainTextSecretFinding["where"];
  /** One short line instead of a sentence per finding: for a row in the server list. */
  compact?: boolean;
}) {
  const findings = mcpPlainTextSecretFindings(server).filter((finding) => !where || finding.where === where);
  if (findings.length === 0) return null;
  return (
    <div className="ade-modern-note" data-tone="warn" data-mcp-plain-secret="">
      <Warning size={14} weight="fill" />
      <div className="ade-modern-note-body">
        {compact
          ? <span>{compactSentence(findings, server.transport)}</span>
          : findings.map((finding) => (
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
