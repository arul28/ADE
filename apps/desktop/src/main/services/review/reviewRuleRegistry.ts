import type { ReviewPassKey } from "../../../shared/types";

export type ReviewRuleCompanionFamily = {
  id: string;
  label: string;
  pathPatterns: string[];
};

export type ReviewRuleAdjudicationPolicy = {
  evidenceMode: "normal" | "cross_boundary";
  requireDualPathConsideration?: boolean;
};

export type ReviewRuleOverlayDefinition = {
  id: "renderer-surface" | "preload-bridge" | "shared-contract" | "mcp-dual-path";
  label: string;
  description: string;
  pathPatterns: string[];
  rolloutExpectations: string[];
  companionFamilies: ReviewRuleCompanionFamily[];
  promptGuidance: Partial<Record<ReviewPassKey, string[]>>;
  adjudicationPolicy: ReviewRuleAdjudicationPolicy;
};

export type MatchedReviewRuleOverlay = ReviewRuleOverlayDefinition & {
  matchedPaths: string[];
  coveredFamilies: Array<Pick<ReviewRuleCompanionFamily, "id" | "label">>;
  missingFamilies: Array<Pick<ReviewRuleCompanionFamily, "id" | "label">>;
};

function matchesPathPattern(filePath: string, pattern: string): boolean {
  if (!pattern.trim()) return false;
  if (pattern.endsWith("/**")) {
    return filePath.startsWith(pattern.slice(0, -3));
  }
  return filePath === pattern;
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPathPattern(filePath, pattern));
}

const REVIEW_RULE_OVERLAYS: ReviewRuleOverlayDefinition[] = [
  {
    id: "renderer-surface",
    label: "Renderer surface",
    description: "Renderer-facing changes should preserve visible flows, edge states, and the shared contracts they consume.",
    pathPatterns: ["apps/desktop/src/renderer/**"],
    rolloutExpectations: [
      "Check user-visible empty, loading, and error states.",
      "Confirm renderer changes still match the shared data shape they consume.",
    ],
    companionFamilies: [
      {
        id: "renderer",
        label: "renderer surface",
        pathPatterns: ["apps/desktop/src/renderer/**"],
      },
    ],
    promptGuidance: {
      "diff-risk": [
        "Treat renderer changes as user-visible behavior changes, not just presentation edits.",
        "Look for broken loading, empty, error, and optimistic states.",
      ],
      "cross-file-impact": [
        "Check whether renderer assumptions still match the shared types and IPC payloads it consumes.",
      ],
    },
    adjudicationPolicy: {
      evidenceMode: "normal",
    },
  },
  {
    id: "preload-bridge",
    label: "Preload bridge",
    description: "Preload bridge changes must keep preload exports, IPC contracts, and renderer consumers aligned.",
    pathPatterns: [
      "apps/desktop/src/preload/**",
      "apps/desktop/src/preload/global.d.ts",
      "apps/desktop/src/shared/ipc.ts",
    ],
    rolloutExpectations: [
      "Keep preload exports, `global.d.ts`, IPC contracts, and renderer call sites in sync.",
      "Treat bridge mismatches as rollout gaps even when the changed file compiles in isolation.",
    ],
    companionFamilies: [
      {
        id: "preload",
        label: "preload bridge",
        pathPatterns: [
          "apps/desktop/src/preload/**",
          "apps/desktop/src/preload/global.d.ts",
        ],
      },
      {
        id: "shared-ipc",
        label: "shared IPC contract",
        pathPatterns: ["apps/desktop/src/shared/ipc.ts"],
      },
      {
        id: "renderer-consumer",
        label: "renderer consumer",
        pathPatterns: ["apps/desktop/src/renderer/**"],
      },
    ],
    promptGuidance: {
      "diff-risk": [
        "Treat preload or IPC edits as bridge changes that can silently break renderer access.",
      ],
      "cross-file-impact": [
        "Explicitly check preload exports, `global.d.ts`, shared IPC contracts, and renderer consumers together.",
      ],
      "checks-and-tests": [
        "Prefer validation evidence that proves the bridge stayed aligned across preload and renderer boundaries.",
      ],
    },
    adjudicationPolicy: {
      evidenceMode: "cross_boundary",
    },
  },
  {
    id: "shared-contract",
    label: "Shared contract",
    description: "Shared contract and type changes should be reviewed as interface rollouts across their desktop consumers.",
    pathPatterns: ["apps/desktop/src/shared/**"],
    rolloutExpectations: [
      "Check whether shared contract changes were rolled out to preload, main, and renderer consumers.",
      "Prefer concrete interface mismatches over speculative API concerns.",
    ],
    companionFamilies: [
      {
        id: "shared",
        label: "shared contract",
        pathPatterns: ["apps/desktop/src/shared/**"],
      },
      {
        id: "preload-consumer",
        label: "preload consumer",
        pathPatterns: [
          "apps/desktop/src/preload/**",
          "apps/desktop/src/preload/global.d.ts",
        ],
      },
      {
        id: "renderer-consumer",
        label: "renderer consumer",
        pathPatterns: ["apps/desktop/src/renderer/**"],
      },
    ],
    promptGuidance: {
      "diff-risk": [
        "Treat shared type or contract changes as interface changes that can break downstream callers.",
      ],
      "cross-file-impact": [
        "Look for missing rollout across preload, renderer, and other shared-contract consumers.",
      ],
      "checks-and-tests": [
        "Use validation evidence to confirm consumer updates actually landed for shared contract changes.",
      ],
    },
    adjudicationPolicy: {
      evidenceMode: "cross_boundary",
    },
  },
  {
    id: "mcp-dual-path",
    label: "MCP dual path",
    description: "ADE MCP changes should keep the headless server path and the desktop socket-backed proxy path in sync.",
    pathPatterns: [
      "apps/mcp-server/**",
      "apps/desktop/src/main/adeMcpProxy.ts",
      "apps/desktop/src/main/adeMcpProxyUtils.ts",
      "apps/desktop/src/main/services/runtime/adeMcpLaunch.ts",
    ],
    rolloutExpectations: [
      "Check both headless MCP mode and the desktop socket-backed launch/proxy path.",
      "Treat one-sided MCP changes as incomplete rollout unless the other path is intentionally unaffected and the diff proves it.",
    ],
    companionFamilies: [
      {
        id: "mcp-server",
        label: "headless MCP server",
        pathPatterns: ["apps/mcp-server/**"],
      },
      {
        id: "desktop-mcp",
        label: "desktop MCP proxy/runtime",
        pathPatterns: [
          "apps/desktop/src/main/adeMcpProxy.ts",
          "apps/desktop/src/main/adeMcpProxyUtils.ts",
          "apps/desktop/src/main/services/runtime/adeMcpLaunch.ts",
        ],
      },
    ],
    promptGuidance: {
      "diff-risk": [
        "Treat MCP edits as transport or protocol changes that can break ADE-native tool execution.",
      ],
      "cross-file-impact": [
        "Before concluding there is no issue, explicitly consider both headless MCP behavior and the desktop socket-backed proxy path.",
      ],
      "checks-and-tests": [
        "Prefer evidence from existing MCP-adjacent validation instead of generic 'add tests' guidance.",
      ],
    },
    adjudicationPolicy: {
      evidenceMode: "cross_boundary",
      requireDualPathConsideration: true,
    },
  },
];

export function getReviewRuleOverlayDefinitions(): ReviewRuleOverlayDefinition[] {
  return REVIEW_RULE_OVERLAYS.map((overlay) => ({
    ...overlay,
    pathPatterns: [...overlay.pathPatterns],
    rolloutExpectations: [...overlay.rolloutExpectations],
    companionFamilies: overlay.companionFamilies.map((family) => ({
      ...family,
      pathPatterns: [...family.pathPatterns],
    })),
    promptGuidance: Object.fromEntries(
      Object.entries(overlay.promptGuidance).map(([passKey, guidance]) => [passKey, [...(guidance ?? [])]]),
    ) as ReviewRuleOverlayDefinition["promptGuidance"],
  }));
}

export function matchReviewRuleOverlays(changedPaths: string[]): MatchedReviewRuleOverlay[] {
  return getReviewRuleOverlayDefinitions().flatMap((overlay) => {
    const matchedPaths = changedPaths.filter((filePath) => matchesAnyPattern(filePath, overlay.pathPatterns));
    if (matchedPaths.length === 0) return [];
    const coveredFamilies = overlay.companionFamilies
      .filter((family) => changedPaths.some((filePath) => matchesAnyPattern(filePath, family.pathPatterns)))
      .map((family) => ({ id: family.id, label: family.label }));
    const missingFamilies = overlay.companionFamilies
      .filter((family) => !coveredFamilies.some((covered) => covered.id === family.id))
      .map((family) => ({ id: family.id, label: family.label }));
    return [{
      ...overlay,
      matchedPaths,
      coveredFamilies,
      missingFamilies,
    }];
  });
}

export function overlayMatchesPath(overlay: Pick<MatchedReviewRuleOverlay, "pathPatterns">, filePath: string | null | undefined): boolean {
  if (!filePath?.trim()) return false;
  return matchesAnyPattern(filePath, overlay.pathPatterns);
}

export function collectRulePromptGuidance(overlays: MatchedReviewRuleOverlay[], passKey: ReviewPassKey): string[] {
  const guidance = overlays.flatMap((overlay) => overlay.promptGuidance[passKey] ?? []);
  return Array.from(new Set(guidance.map((line) => line.trim()).filter(Boolean)));
}
