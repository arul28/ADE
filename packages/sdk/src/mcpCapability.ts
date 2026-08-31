import type { McpCapabilityReport } from "./types.js";

/**
 * Validates the runtime's MCP capability report before it reaches the public
 * API. An unrecognised `level` is dropped rather than widened: a caller
 * branching on "enforced" must never be handed a value the SDK cannot vouch for.
 */
export function normalizeMcpCapability(value: unknown): McpCapabilityReport | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<McpCapabilityReport>;
  if (
    source.level !== "enforced" &&
    source.level !== "best-effort" &&
    source.level !== "unsupported"
  ) {
    return null;
  }
  const strictRequested = source.strictRequested === true;
  return {
    level: source.level,
    mechanism: typeof source.mechanism === "string" ? source.mechanism : "",
    // Null whenever strict mode was not requested: `residual` names what strict
    // mode could not exclude, and a delivery-only thread excluded nothing by
    // design. A runtime that volunteered one anyway would be describing an
    // isolation ADE was never asked to perform.
    residual: strictRequested && typeof source.residual === "string" ? source.residual : null,
    delivered: source.delivered === true,
    // Absent on a runtime that predates the field. False is the conservative
    // reading: it understates isolation rather than promising one nothing
    // verified.
    strictRequested,
  };
}
