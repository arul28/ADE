import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

// Curated to selectors that always render on /lanes regardless of which sub-pane
// (Stack / Diff / Git Actions / Work) is currently active. Sub-pane content is
// covered by dedicated tours (laneWorkPaneTour, the gitActionsPane builder, the
// Files tab) so a user can drill into any of them independently.
export const lanesTour: Tour = {
  id: "lanes",
  title: "Lanes walkthrough",
  route: "/lanes",
  steps: [
    {
      target: '[data-tour="lanes.branchSelector"]',
      title: "The clean starting point",
      body: "Every sandbox copy needs a starting point. ADE uses your project's main branch (usually `main`) for that. Each new lane copies from here, and ADE always compares the lane's changes back to it.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.statusChips"]',
      title: "What's going on with each lane",
      body: "These badges show the status of every lane at a glance. **Running** = active work. **Waiting** = needs you (or an AI) to make a call. **Ended** = done or put away.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.newLane"]',
      title: "Make or adopt a lane",
      body: "Make a brand-new sandbox copy from your main project, or adopt one you already have lying around (like a Git branch you started outside ADE). Either way, your real project stays untouched.",
      docUrl: docs.lanesCreating,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.laneTab"], [data-tour="lanes.newLane"]',
      title: "Switch between lanes",
      body: "Each tab is one open sandbox copy. Click to switch between tasks. Little badges call out things like \"has unsaved changes\" or \"pinned\", so you can see what each lane needs at a glance.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
  ],
};

registerTour(lanesTour);

export default lanesTour;
