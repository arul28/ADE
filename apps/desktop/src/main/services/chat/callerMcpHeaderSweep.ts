import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import { writeFileAtomic } from "../state/durableFile";

/**
 * Written once the sweep has finished cleanly, so it runs once per project
 * rather than on every start. A sweep with any failure leaves no marker and
 * runs again next start; the sweep is idempotent, so a rerun is harmless.
 */
const SWEEP_MARKER = ".caller-mcp-header-values-swept-v1";

/** Only the primary record and its last-known-good copy carry chat state. */
const STATE_FILE = /\.json(\.lkg)?$/;

/** True when some remote server in `value` still carries header values. */
function carriesHeaderValues(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).some((server) => {
    if (!server || typeof server !== "object") return false;
    const record = server as Record<string, unknown>;
    return record.type !== "stdio" && record.headers != null;
  });
}

/**
 * The raw map with every remote server's `headers` replaced by `headerNames`
 * — the shape `withholdCallerMcpHeaderValues` writes — and nothing else
 * touched. Raw rather than normalized: normalizing would also drop a server
 * this build happens to reject, which is not this sweep's call to make.
 */
function withholdRawHeaderValues(servers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const record = server && typeof server === "object" ? server as Record<string, unknown> : null;
    if (!record || record.type === "stdio" || record.headers == null) {
      out[name] = server;
      continue;
    }
    const { headers, headerNames: _existing, ...rest } = record;
    const headerNames = headers && typeof headers === "object" && !Array.isArray(headers)
      ? Object.keys(headers)
      : [];
    out[name] = headerNames.length ? { ...rest, headerNames } : rest;
  }
  return out;
}

/**
 * Take MCP header values off disk for personal chats persisted before ADE
 * stopped writing them (runtimes before 1.2.81).
 *
 * Every write since then withholds the values, but a chat nobody reopened —
 * and the `.lkg` copy a write leaves behind — would keep the credential on
 * disk indefinitely. This rewrites each such file with `mcpServers` in the
 * withheld form (header names kept in `headerNames`), leaving every other
 * field byte-for-byte as it was parsed.
 *
 * Runs synchronously at service start, before any chat is loaded, so no
 * persist can race it. Best-effort: a file that cannot be read or written is
 * logged and skipped, and never stops the service from starting.
 */
export function sweepPersistedCallerMcpHeaderValues(chatSessionsDir: string, logger: Logger): void {
  const markerPath = path.join(chatSessionsDir, SWEEP_MARKER);
  if (fs.existsSync(markerPath)) return;
  let names: string[];
  try {
    names = fs.readdirSync(chatSessionsDir).filter((name) => STATE_FILE.test(name));
  } catch (error) {
    logger.warn("agent_chat.caller_mcp_header_sweep_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  let rewritten = 0;
  let failed = 0;
  for (const name of names) {
    const filePath = path.join(chatSessionsDir, name);
    try {
      const text = fs.readFileSync(filePath, "utf8");
      // Cheap pre-check: most records have no caller servers at all.
      if (!text.includes("\"headers\"")) continue;
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        // Unparseable, so the app cannot load it either; retrying it every
        // start would only keep the sweep from ever finishing.
        continue;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const state = record as Record<string, unknown>;
      if (!carriesHeaderValues(state.mcpServers)) continue;
      const next = { ...state, mcpServers: withholdRawHeaderValues(state.mcpServers as Record<string, unknown>) };
      writeFileAtomic(filePath, JSON.stringify(next, null, 2));
      rewritten += 1;
    } catch (error) {
      failed += 1;
      logger.warn("agent_chat.caller_mcp_header_sweep_file_failed", {
        file: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (rewritten > 0 || failed > 0) {
    logger.info("agent_chat.caller_mcp_header_sweep", { rewritten, failed });
  }
  if (failed > 0) return;
  try {
    writeFileAtomic(markerPath, `${new Date().toISOString()}\n`);
  } catch {
    // No marker only means the (idempotent) sweep runs again next start.
  }
}
