// Centralised docs URLs referenced from tours and the Help menu.
//
// Public docs live under the Mintlify `/docs` prefix. Keep these paths in sync
// with the public site so onboarding links never send users to dead pages.

const SITE_BASE = "https://www.ade-app.dev";
const DOCS_BASE = `${SITE_BASE}/docs`;

export const docs = {
  // Root / welcome
  home: DOCS_BASE,
  welcome: `${DOCS_BASE}/welcome`,
  keyConcepts: `${DOCS_BASE}/key-concepts`,

  // Lanes
  lanesOverview: `${DOCS_BASE}/lanes/overview`,
  lanesCreating: `${DOCS_BASE}/lanes/creating`,
  lanesStacks: `${DOCS_BASE}/lanes/stacks`,
  lanesPacks: `${DOCS_BASE}/lanes/packs`,
  lanesEnvironment: `${DOCS_BASE}/lanes/environment`,

  // Chat / work / terminals
  chatOverview: `${DOCS_BASE}/chat/overview`,
  chatContext: `${DOCS_BASE}/chat/context`,
  chatCapabilities: `${DOCS_BASE}/chat/capabilities`,
  terminals: `${DOCS_BASE}/tools/terminals`,
  filesEditor: `${DOCS_BASE}/tools/files-editor`,

  // First-run / getting-started
  gettingStartedFirstLane: `${DOCS_BASE}/getting-started/first-lane`,
  firstLane: `${DOCS_BASE}/getting-started/first-lane`,

  // Higher-level product areas
  projectHome: `${DOCS_BASE}/tools/project-home`,
  missionsOverview: `${DOCS_BASE}/missions/overview`,
  ctoOverview: `${DOCS_BASE}/cto/overview`,
  automationsOverview: `${DOCS_BASE}/automations/overview`,
  workspaceGraph: `${DOCS_BASE}/tools/workspace-graph`,
  computerUseOverview: `${DOCS_BASE}/computer-use/overview`,
  settingsGeneral: `${DOCS_BASE}/configuration/settings`,
  prsOverview: `${DOCS_BASE}/tools/pull-requests`,
  historyOverview: `${DOCS_BASE}/tools/history`,

  // Guides
  multiAgentSetup: `${DOCS_BASE}/guides/multi-agent-setup`,
} as const;

export type DocsKey = keyof typeof docs;
export const DOCS_HOME = docs.home;
