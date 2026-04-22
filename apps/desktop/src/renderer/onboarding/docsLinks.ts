// Centralised docs URLs referenced from tours and the Help menu.
//
// The public docs site paths DO NOT include a `/docs/` prefix — the real site
// structure is `https://www.ade-app.dev/<section>/<page>`. Do not add `/docs/`.
// If a key points at a page that may not exist yet, prefer falling back to
// `docs.home`. Keys marked `// TODO: verify` are best-guess paths that match
// the site's section layout but have not been confirmed live.

const DOCS_BASE = "https://www.ade-app.dev";

export const docs = {
  // Root / welcome
  home: DOCS_BASE,
  welcome: `${DOCS_BASE}/welcome`,
  keyConcepts: `${DOCS_BASE}/welcome`, // TODO: verify — no dedicated key-concepts page yet

  // Lanes
  lanesOverview: `${DOCS_BASE}/lanes/overview`,
  lanesCreating: `${DOCS_BASE}/lanes/overview`, // TODO: verify — creating lanes covered in overview today
  lanesStacks: `${DOCS_BASE}/lanes/overview`, // TODO: verify — stacks live under lanes section
  lanesPacks: `${DOCS_BASE}/lanes/overview`, // TODO: verify
  lanesEnvironment: `${DOCS_BASE}/lanes/overview`, // TODO: verify

  // Chat / work / terminals
  chatOverview: `${DOCS_BASE}/missions/overview`, // TODO: verify — chat lives under missions/cto docs
  chatContext: `${DOCS_BASE}/missions/overview`, // TODO: verify
  chatCapabilities: `${DOCS_BASE}/missions/overview`, // TODO: verify
  terminals: `${DOCS_BASE}/tools/project-home`, // TODO: verify — no dedicated terminals page yet
  filesEditor: `${DOCS_BASE}/tools/project-home`, // TODO: verify — file editor covered under project-home tools

  // First-run / getting-started
  gettingStartedFirstLane: `${DOCS_BASE}/welcome`, // TODO: verify — first-lane guide lives under welcome today
  firstLane: `${DOCS_BASE}/welcome`, // TODO: verify — alias for gettingStartedFirstLane

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
  multiAgentSetup: `${DOCS_BASE}/missions/overview`, // TODO: verify — no dedicated guide yet
} as const;

export type DocsKey = keyof typeof docs;
export const DOCS_HOME = docs.home;
