// Centralised docs URLs referenced from tours and the Help menu.
//
// Public docs live under the Mintlify `/docs` prefix. Keep these paths in sync
// with the public site so onboarding links never send users to dead pages.

const SITE_BASE = "https://www.ade-app.dev";
const DOCS_BASE = `${SITE_BASE}/docs`;

export const docs = {
  // Root / welcome
  home: SITE_BASE,
  welcome: `${DOCS_BASE}/welcome`,
  keyConcepts: `${DOCS_BASE}/key-concepts`,

  // Lanes
  lanesOverview: `${DOCS_BASE}/lanes/overview`,
  lanesCreating: `${DOCS_BASE}/lanes/overview`,
  lanesStacks: `${DOCS_BASE}/lanes/overview`,
  lanesPacks: `${DOCS_BASE}/lanes/overview`,
  lanesEnvironment: `${DOCS_BASE}/lanes/overview`,

  // Chat / work / terminals
  chatOverview: `${DOCS_BASE}/missions/overview`,
  chatContext: `${DOCS_BASE}/missions/overview`,
  chatCapabilities: `${DOCS_BASE}/missions/overview`,
  terminals: `${DOCS_BASE}/tools/project-home`,
  filesEditor: `${DOCS_BASE}/tools/project-home`,

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
  multiAgentSetup: `${DOCS_BASE}/missions/overview`,
} as const;

export type DocsKey = keyof typeof docs;
export const DOCS_HOME = docs.home;
