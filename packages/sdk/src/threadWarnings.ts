/**
 * What a freshly opened thread has to say about itself.
 *
 * THE RULE THIS FILE ENCODES: asking for something and being told nothing is
 * not the same as not asking, and only the client knows which of the two
 * happened. A runtime that omits a capability report leaves a `null` behind,
 * and `null` is documented as "this thread asked for nothing" — so a request
 * that went unanswered would read downstream as a request never made. Every
 * line below exists to stop one such silence from passing for a fact.
 *
 * Pure on purpose: it takes what the open resolved and returns the lines, and
 * the caller logs them. That makes the honesty rules — the part of this surface
 * most likely to be edited next — testable without a runtime, a socket, or a
 * `createAdeChat` round trip.
 */

import type {
  InstructionsCapability,
  PermissionCapability,
  SettingSourcesCapability,
} from "./hostConfig.js";
import {
  individualMcpToolEntries,
  mcpServersNotCoveredByPolicy,
  type ThreadPermissionPolicy,
} from "./permissions.js";
import type { AgentChatInstructions, McpCapabilityReport, McpServerConfig } from "./types.js";

export type ThreadOpenWarningInput = {
  /** The durable thread key, for naming the thread in every line. */
  key: string;
  /** Whether the caller actually supplied one or more MCP servers. */
  suppliedServers: boolean;
  /** The servers themselves, when any were supplied. */
  mcpServers?: Record<string, McpServerConfig> | undefined;
  /**
   * The tristate the caller set, or `undefined` when they set nothing.
   * `false` is an explicit strictness request and expects a report; `true` is
   * delivery-only and expects none.
   */
  loadUserMcpServers?: boolean | undefined;
  instructions?: AgentChatInstructions | undefined;
  settingSources?: string | undefined;
  permissionPolicy?: ThreadPermissionPolicy | undefined;
  mcpCapability: McpCapabilityReport | null;
  instructionsCapability: InstructionsCapability | null;
  settingSourcesCapability: SettingSourcesCapability | null;
  permissionCapability: PermissionCapability | null;
};

/**
 * Every warning a newly created thread earns, in the order they are logged.
 *
 * Returns an empty array for the ordinary case, which is most threads.
 */
export function threadOpenWarnings(input: ThreadOpenWarningInput): string[] {
  const {
    key,
    suppliedServers,
    mcpServers,
    loadUserMcpServers,
    instructions,
    settingSources,
    permissionPolicy,
    mcpCapability,
    instructionsCapability,
    settingSourcesCapability,
    permissionCapability,
  } = input;
  const lines: string[] = [];

  // Scoped to requests the runtime actually reports on: supplied servers, or
  // an explicit strictness request. A bare `loadUserMcpServers: true` asks for
  // nothing to be withheld and nothing to be injected, so the runtime emits no
  // capability report BY DESIGN — warning there would cry wolf on every
  // correct delivery-only thread, and a warning that fires when nothing is
  // wrong stops being read when something is.
  const expectsCapabilityReport = suppliedServers || loadUserMcpServers === false;
  if (expectsCapabilityReport && !mcpCapability) {
    // The caller asked and the runtime said nothing. Silence here would read
    // downstream as "no MCP was requested", which is the one wrong conclusion
    // available — so name it instead.
    lines.push(
      `ade sdk: thread "${key}" requested MCP but the runtime reported no capability; treat the guarantee as unverified`,
    );
  }
  // Branch on `level`, never on `delivered`. `delivered` is false for a
  // provider with no MCP surface, and older runtimes ALSO returned false for a
  // strict-only request (strict mode, no servers) that had in fact been
  // enforced perfectly — so a client keyed on it reported a successful
  // isolation request as a failure. `level` is the field that actually varies,
  // and "unsupported" is the only value meaning nothing landed.
  //
  // Guarded on `suppliedServers` as well: with no servers to drop there is
  // nothing to warn about, whatever the runtime reports.
  if (suppliedServers && mcpCapability?.level === "unsupported") {
    lines.push(
      `ade sdk: thread "${key}" opened WITHOUT the requested MCP servers (${mcpCapability.mechanism})`,
    );
  }
  // Independent of the above, not chained to it: a best-effort residual must
  // still surface on a thread whose servers did land.
  if (mcpCapability?.residual) {
    lines.push(`ade sdk: thread "${key}" MCP strict mode is best-effort: ${mcpCapability.residual}`);
  }

  // Same rule as the MCP report above, for the same reason.
  if (instructions && !instructionsCapability) {
    lines.push(
      `ade sdk: thread "${key}" sent instructions but the runtime reported no capability; ` +
        `treat the text as possibly not delivered`,
    );
  }
  if (settingSources && !settingSourcesCapability) {
    lines.push(
      `ade sdk: thread "${key}" sent settingSources but the runtime reported no capability; ` +
        `the provider's configuration layers are unknown`,
    );
  }
  if (permissionPolicy && !permissionCapability) {
    lines.push(
      `ade sdk: thread "${key}" sent a permission policy but the runtime reported no capability; ` +
        `treat the policy as unenforced`,
    );
  }
  if (instructionsCapability && instructionsCapability.level !== "applied") {
    lines.push(
      `ade sdk: thread "${key}" instructions are ${instructionsCapability.level}` +
        `${instructionsCapability.detail ? `: ${instructionsCapability.detail}` : ""}`,
    );
  }
  if (settingSourcesCapability && settingSourcesCapability.level === "ignored") {
    lines.push(
      `ade sdk: thread "${key}" settingSources was ignored by this provider` +
        `${settingSourcesCapability.detail ? `: ${settingSourcesCapability.detail}` : ""}`,
    );
  }
  // Two shapes that are legal, are not widened here, and are quiet enough to
  // cost an afternoon. Both are only meaningful under `fallback: "deny"`, where
  // anything the policy does not name is refused outright.
  if (permissionPolicy?.fallback === "deny") {
    if (suppliedServers && mcpServers) {
      const blocked = mcpServersNotCoveredByPolicy(permissionPolicy, Object.keys(mcpServers));
      if (blocked.length > 0) {
        // Injecting a server and then denying all of it has no symptom: the
        // tools are never called and the model just reports it could not do
        // the thing.
        lines.push(
          `ade sdk: thread "${key}" fallback: deny blocks every tool of MCP servers not named by the policy: ${blocked.join(", ")}`,
        );
      }
    }
    const toolEntries = individualMcpToolEntries(permissionPolicy);
    if (toolEntries.length > 0) {
      lines.push(
        `ade sdk: thread "${key}" names individual MCP tools (${toolEntries.join(", ")}); ` +
          `on Claude an individual MCP tool entry admits the whole server; read permissionCapability.residual`,
      );
    }
  }
  if (permissionCapability && permissionCapability.level !== "enforced") {
    lines.push(
      `ade sdk: thread "${key}" permission policy is ${permissionCapability.level}` +
        `${permissionCapability.residual ? `: ${permissionCapability.residual}` : ""}`,
    );
  }

  return lines;
}

export type ThreadResumeMismatchInput = {
  key: string;
  /** Options the caller passed to this `open()` call, already normalized. */
  supplied: {
    cwd?: string | undefined;
    instructions?: AgentChatInstructions | undefined;
    settingSources?: string | undefined;
    permissions?: unknown;
    mcpServers?: Record<string, unknown> | undefined;
    loadUserMcpServers?: boolean | undefined;
  };
  /** What the key was created with, off the durable record. */
  stored: {
    cwd?: string | undefined;
    instructions?: AgentChatInstructions | undefined;
    settingSources?: string | undefined;
    permissionPolicy?: ThreadPermissionPolicy | undefined;
    mcpServers?: Record<string, unknown> | undefined;
    loadUserMcpServers?: boolean | undefined;
  };
};

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Warnings for a resume that was handed host-configuration options it will not
 * apply.
 *
 * A resume rebuilds the thread the key was CREATED with. That is the documented
 * rule and it does not change here, but a caller who passes a new `cwd` and a
 * new policy and gets neither must be told: believing an agent is confined to a
 * directory and a rule set it is not confined to is the worst outcome this
 * surface has.
 */
export function threadResumeMismatchWarnings(input: ThreadResumeMismatchInput): string[] {
  const { key, supplied, stored } = input;
  const lines: string[] = [];
  const ignored = (field: string, storedValue: string): string =>
    `ade sdk: thread "${key}" resumed with its stored ${field} (${storedValue}); the ${field} passed to open() was ignored`;

  // No `stored.cwd !== undefined` clause, deliberately, and unlike an earlier
  // version of this check. A thread created without a `cwd` is the common case,
  // and supplying one on resume is exactly when the caller most needs telling:
  // they believe the agent works in their project while it runs in the runtime's
  // scratch workspace.
  if (supplied.cwd !== undefined && supplied.cwd !== stored.cwd) {
    lines.push(ignored("cwd", stored.cwd ?? "the runtime's default workspace"));
  }
  if (supplied.instructions !== undefined && !sameJson(supplied.instructions, stored.instructions)) {
    lines.push(ignored("instructions", stored.instructions ? "the stored text" : "none"));
  }
  if (
    supplied.settingSources !== undefined &&
    supplied.settingSources !== stored.settingSources
  ) {
    lines.push(ignored("settingSources", stored.settingSources ?? "none"));
  }
  if (supplied.permissions !== undefined && !sameJson(supplied.permissions, stored.permissionPolicy)) {
    lines.push(ignored("permissions", stored.permissionPolicy ? "the stored policy" : "the stored preset"));
  }
  // The tool surface, for the same reason as the four above and with a sharper
  // consequence: an embedder that reopens with a new server map and
  // `loadUserMcpServers: false` and is told nothing may present "only your
  // tools are loaded" on the strength of an option that never reached the
  // runtime.
  if (supplied.mcpServers !== undefined && !sameJson(supplied.mcpServers, stored.mcpServers)) {
    lines.push(ignored("mcpServers", stored.mcpServers ? "the stored servers" : "none"));
  }
  if (
    supplied.loadUserMcpServers !== undefined &&
    supplied.loadUserMcpServers !== stored.loadUserMcpServers
  ) {
    lines.push(ignored(
      "loadUserMcpServers",
      stored.loadUserMcpServers === undefined
        ? "the session profile's own default"
        : String(stored.loadUserMcpServers),
    ));
  }
  return lines;
}
