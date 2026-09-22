// The agent skills ADE ships inside the package, as the packaging validators
// expect to find them.
//
// This roster is a *mirror* of apps/desktop/resources/agent-skills/, not its
// source: validate-packaged-tree.mjs runs against a built artifact, so it needs
// a declared expectation rather than a directory listing that would trivially
// agree with whatever happened to be copied.
//
// It lives in its own module for two reasons. The validators are plain Node
// .mjs and cannot import the renderer-side TypeScript list in
// src/shared/adeCliGuidance.ts (that file is bundled into the renderer, so it
// can neither read the filesystem nor import from main/). And a TypeScript test
// *can* import this file -- see bundled-agent-skills.d.mts -- which is what
// binds the two rosters and the real directory together in
// src/shared/bundledAgentSkills.test.ts.
//
// Adding a skill means: create resources/agent-skills/<name>/SKILL.md, add the
// name here, and add it to `adeBundledAgentSkills` in
// src/shared/adeCliGuidance.ts. Miss either list and that test fails.
//
// Both validators carried this list verbatim before it was extracted; a skill
// added to one and not the other shipped on one platform only, which is the
// kind of gap nobody notices until a user on the other platform reports a
// missing capability.
export const BUNDLED_AGENT_SKILLS = Object.freeze([
  "ade-app-control",
  "ade-apple",
  "ade-browser",
  "ade-cli-control-plane",
  "ade-deeplinks",
  "ade-harnesses",
  "ade-ios-simulator",
  "ade-lanes-git",
  "ade-linear",
  "ade-mosaic",
  "ade-pr-workflows",
  "ade-proof-artifacts",
  "ade-scene",
  "ade-search",
]);
