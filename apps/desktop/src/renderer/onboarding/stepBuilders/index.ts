// Barrel for shared step builders. Small factory functions that return
// `TourStep[]` for a specific UX beat — e.g. the CreateLaneDialog walkthrough
// or the CreatePrModal walkthrough. The flagship Tutorial and per-tab tours
// both import from here so that copy + anchors live in one place.

export { buildCreateLaneDialogWalkthrough } from "./createLaneDialog";
export { buildPrCreateModalWalkthrough } from "./prCreateModal";
export { buildGitActionsPaneWalkthrough } from "./gitActionsPane";
export { buildManageLaneDialogWalkthrough } from "./manageLaneDialog";
