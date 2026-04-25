import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

// commandCards / runtimeBar / processMonitor host conditionally-rendered
// content (cards / live runtimes / running processes). Their wrapper divs
// always exist, so the addCommand step here points at the always-visible
// "Add command" button — the conditional surfaces become useful once the
// user has actually defined or started something.
export const runTour: Tour = {
  id: "run",
  title: "Run tab walkthrough",
  route: "/project",
  steps: [
    {
      target: '[data-tour="run.laneSelector"]',
      title: "Where it runs",
      body: "Each lane has its own copy of the project, so when you start something it runs inside *one* lane's copy. Pick the default lane here — you can override it on each command if you want.",
      docUrl: docs.lanesStacks,
      placement: "bottom",
    },
    {
      target: '[data-tour="run.stackTabs"]',
      title: "Group commands together",
      body: "A **Stack** is a name you give to a group of commands you usually run together — like \"dev\" (your dev server + watcher), \"test\" (lint + tests), or \"deploy\". Click a tab to filter, then **Run stack** to start them all at once.",
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
