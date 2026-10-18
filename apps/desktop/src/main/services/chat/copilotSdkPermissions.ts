import type { PermissionRequestResult } from "@github/copilot-sdk";
import { asRecord as record } from "../shared/utils";

type SessionApproval = Extract<PermissionRequestResult, { kind: "approve-for-session" }>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The "Allow for this session" answer Copilot can remember for one permission
 * prompt (`permission.requested`'s `promptRequest`), or null when Copilot says
 * it cannot offer one. The rule names what is remembered: the command
 * identifiers, the MCP tool, the URL's domain. A bare answer without it leaves
 * Copilot nothing to match the next request against.
 *
 * With no prompt at all (an older runtime) the bare answer is kept, as before.
 */
export function copilotSessionApproval(promptRequest: unknown): SessionApproval | null {
  const prompt = record(promptRequest);
  if (!prompt) return { kind: "approve-for-session" };
  switch (prompt.kind) {
    case "commands": {
      const ids = Array.isArray(prompt.commandIdentifiers)
        ? prompt.commandIdentifiers.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      return prompt.canOfferSessionApproval === true && ids.length
        ? { kind: "approve-for-session", approval: { kind: "commands", commandIdentifiers: ids } }
        : null;
    }
    case "write":
      return prompt.canOfferSessionApproval === true ? { kind: "approve-for-session", approval: { kind: "write" } } : null;
    case "read":
      return { kind: "approve-for-session", approval: { kind: "read" } };
    case "memory":
      return { kind: "approve-for-session", approval: { kind: "memory" } };
    case "mcp": {
      // A null toolName approves the whole server, which this per-tool prompt never offers.
      const serverName = text(prompt.serverName);
      const toolName = text(prompt.toolName);
      return serverName && toolName ? { kind: "approve-for-session", approval: { kind: "mcp", serverName, toolName } } : null;
    }
    case "custom-tool": {
      const toolName = text(prompt.toolName);
      return toolName ? { kind: "approve-for-session", approval: { kind: "custom-tool", toolName } } : null;
    }
    case "url": {
      try {
        const domain = new URL(String(prompt.url)).hostname;
        return domain ? { kind: "approve-for-session", domain } : null;
      } catch {
        return null;
      }
    }
    case "extension-management": {
      const operation = text(prompt.operation);
      return { kind: "approve-for-session", approval: { kind: "extension-management", ...(operation ? { operation } : {}) } };
    }
    case "extension-permission-access": {
      const extensionName = text(prompt.extensionName);
      return extensionName ? { kind: "approve-for-session", approval: { kind: "extension-permission-access", extensionName } } : null;
    }
    case "workflow": {
      const approvalKey = text(prompt.approvalKey);
      return prompt.canPersistApproval === true && approvalKey
        ? { kind: "approve-for-session", approval: { kind: "workflow", approvalKey } }
        : null;
    }
    // Path grants, hook prompts and extension env access have no session rule.
    default:
      return null;
  }
}
