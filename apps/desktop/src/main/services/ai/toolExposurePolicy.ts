const FRONTEND_HIGH_CONFIDENCE_SIGNALS: Array<{ label: string; pattern: RegExp }> = [
  { label: "website", pattern: /\bwebsite\b/i },
  { label: "web-app", pattern: /\bweb\s+app\b/i },
  { label: "webpage", pattern: /\bweb\s*page\b/i },
  { label: "frontend", pattern: /\bfront\s*end\b|\bfrontend\b/i },
  { label: "react", pattern: /\breact\b/i },
  { label: "tsx-jsx", pattern: /\btsx\b|\bjsx\b/i },
  { label: "ui", pattern: /\bui\b|\buser interface\b/i },
  { label: "tab", pattern: /\btabs?\b/i },
  { label: "navbar", pattern: /\bnavbar\b|\bnav\s+bar\b/i },
  { label: "sidebar", pattern: /\bsidebar\b/i },
  { label: "layout", pattern: /\blayout\b/i },
  { label: "css-html", pattern: /\bcss\b|\bhtml\b/i },
];

const FRONTEND_SUPPORTING_SIGNALS: Array<{ label: string; pattern: RegExp }> = [
  { label: "page", pattern: /\bpages?\b/i },
  { label: "screen", pattern: /\bscreens?\b/i },
  { label: "component", pattern: /\bcomponents?\b/i },
  { label: "route", pattern: /\broutes?\b/i },
  { label: "router", pattern: /\brouter\b/i },
  { label: "navigation", pattern: /\bnavigation\b|\bnav\b/i },
  { label: "menu", pattern: /\bmenu\b/i },
  { label: "header-footer", pattern: /\bheader\b|\bfooter\b/i },
  { label: "button-form-modal", pattern: /\bbutton\b|\bform\b|\bmodal\b/i },
  { label: "link-view", pattern: /\blink\b|\bview\b/i },
];

export const FRONTEND_REPO_DISCOVERY_TOOL_NAMES = [
  "findRoutingFiles",
  "findPageComponents",
  "findAppEntryPoints",
  "summarizeFrontendStructure",
] as const;

export type FrontendRepoToolExposureDecision = {
  enabled: boolean;
  score: number;
  signals: string[];
};

export function decideFrontendRepoToolExposure(promptText: string): FrontendRepoToolExposureDecision {
  const text = promptText.trim();
  if (!text.length) {
    return { enabled: false, score: 0, signals: [] };
  }

  const matchedSignals: string[] = [];
  let score = 0;

  for (const signal of FRONTEND_HIGH_CONFIDENCE_SIGNALS) {
    if (!signal.pattern.test(text)) continue;
    matchedSignals.push(signal.label);
    score += 2;
  }

  for (const signal of FRONTEND_SUPPORTING_SIGNALS) {
    if (!signal.pattern.test(text)) continue;
    matchedSignals.push(signal.label);
    score += 1;
  }

  return {
    enabled: score >= 2,
    score,
    signals: matchedSignals,
  };
}

export function filterFrontendRepoDiscoveryTools<T>(
  tools: Record<string, T>,
  enabled: boolean,
): Record<string, T> {
  if (enabled) return tools;

  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !FRONTEND_REPO_DISCOVERY_TOOL_NAMES.includes(name as typeof FRONTEND_REPO_DISCOVERY_TOOL_NAMES[number])),
  ) as Record<string, T>;
}
