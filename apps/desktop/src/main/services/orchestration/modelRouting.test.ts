/* @vitest-environment node */
import { describe, expect, it } from "vitest";

import type {
  ModelRouting,
  ModelSelection,
} from "../../../shared/types/orchestration";

/**
 * Resolution order: byRoleTag → byTag → byRole → default → caller-supplied fallback.
 * Mirrors `resolveOrchestrationModel` in registerIpc.ts; kept here as a pure function
 * so we can unit-test precedence without booting the IPC layer.
 */
function resolve(
  routing: ModelRouting,
  role: "worker" | "validator",
  tag: string,
  fallback: ModelSelection,
  override?: ModelSelection,
): { selection: ModelSelection; routingKey: string } {
  if (override) return { selection: override, routingKey: "override" };
  if (routing.byRoleTag?.[`${role}:${tag}`]) {
    return { selection: routing.byRoleTag[`${role}:${tag}`]!, routingKey: "byRoleTag" };
  }
  if (routing.byTag?.[tag]) {
    return { selection: routing.byTag[tag]!, routingKey: "byTag" };
  }
  if (routing.byRole?.[role]) {
    return { selection: routing.byRole[role]!, routingKey: "byRole" };
  }
  if (routing.default) {
    return { selection: routing.default, routingKey: "default" };
  }
  return { selection: fallback, routingKey: "fallback" };
}

const FALLBACK: ModelSelection = {
  provider: "claude",
  modelId: "claude-sonnet-4-6",
  reasoningEffort: null,
};

describe("model routing precedence", () => {
  it("byRoleTag wins over byTag/byRole/default", () => {
    const routing: ModelRouting = {
      default: { provider: "claude", modelId: "default" },
      byRole: { worker: { provider: "claude", modelId: "byrole" } },
      byTag: { "web-ui": { provider: "claude", modelId: "bytag" } },
      byRoleTag: { "worker:web-ui": { provider: "claude", modelId: "byroletag" } },
    };
    const res = resolve(routing, "worker", "web-ui", FALLBACK);
    expect(res.selection.modelId).toBe("byroletag");
    expect(res.routingKey).toBe("byRoleTag");
  });

  it("byTag wins over byRole/default when no byRoleTag", () => {
    const routing: ModelRouting = {
      default: { provider: "claude", modelId: "default" },
      byRole: { worker: { provider: "claude", modelId: "byrole" } },
      byTag: { "web-ui": { provider: "claude", modelId: "bytag" } },
    };
    const res = resolve(routing, "worker", "web-ui", FALLBACK);
    expect(res.selection.modelId).toBe("bytag");
    expect(res.routingKey).toBe("byTag");
  });

  it("byRole wins over default when no byTag", () => {
    const routing: ModelRouting = {
      default: { provider: "claude", modelId: "default" },
      byRole: { worker: { provider: "claude", modelId: "byrole" } },
    };
    const res = resolve(routing, "worker", "anything", FALLBACK);
    expect(res.selection.modelId).toBe("byrole");
    expect(res.routingKey).toBe("byRole");
  });

  it("default wins when nothing else applies", () => {
    const routing: ModelRouting = {
      default: { provider: "claude", modelId: "default" },
    };
    const res = resolve(routing, "validator", "anything", FALLBACK);
    expect(res.selection.modelId).toBe("default");
    expect(res.routingKey).toBe("default");
  });

  it("caller fallback when routing is empty", () => {
    const res = resolve({}, "validator", "anything", FALLBACK);
    expect(res.selection.modelId).toBe("claude-sonnet-4-6");
    expect(res.routingKey).toBe("fallback");
  });

  it("override wins everything", () => {
    const routing: ModelRouting = {
      default: { provider: "claude", modelId: "default" },
      byRoleTag: { "worker:web-ui": { provider: "claude", modelId: "byroletag" } },
    };
    const override: ModelSelection = { provider: "codex", modelId: "o-1" };
    const res = resolve(routing, "worker", "web-ui", FALLBACK, override);
    expect(res.selection.provider).toBe("codex");
    expect(res.routingKey).toBe("override");
  });
});
