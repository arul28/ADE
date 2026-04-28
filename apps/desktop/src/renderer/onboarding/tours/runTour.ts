import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

// commandCards / runtimeBar: lane runtime details live behind the header
// "Advanced" toggle; group filter wrapper always exists. The addCommand
// step points at the always-visible "Add command" button — command cards
// appear once the user has defined commands.
export const runTour: Tour = {
  id: "run",
  title: "Run tab walkthrough",
  route: "/project",
  steps: [
    {
      target: '[data-tour="run.runtimeBar"]',
      title: "Where it runs",
      body: "Each lane has its own copy of the project. **Run** targets your primary lane by default (groups, new shell). Open **Advanced** in the header for preview URL, health, and OAuth callback details — or pick a different lane on each command card when you need an override.",
      docUrl: docs.lanesStacks,
      placement: "bottom",
    },
    {
      target: '[data-tour="run.groupFilter"]',
      title: "Filter by group",
      body: "Assign commands to **groups** when you add or edit them. Use **All commands** or a specific group chip to filter cards; **New group** adds an empty group you can attach commands to. When a group is selected, **Run all** / **Stop all** in the header targets every command in that group (respecting each card's lane).",
      docUrl: docs.lanesStacks,
      placement: "bottom",
    },
    {
      target: '[data-tour="run.addCommand"]',
      title: "Add a command",
      body: "Save any shell command as a clickable button: a dev server, a test runner, a build script — anything. Give it a name and the command itself, and it shows up as a card you can launch any time.",
      docUrl: docs.lanesStacks,
      placement: "bottom",
    },
  ],
};

registerTour(runTour);

export default runTour;
