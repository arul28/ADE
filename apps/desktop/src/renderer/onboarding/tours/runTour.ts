import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const runTour: Tour = {
  id: "run",
  title: "Run tab walkthrough",
  route: "/project",
  steps: [
    {
      target: '[data-tour="run.header"]',
      title: "Run tab",
      body: "Run is your process manager. Define commands once, then start, stop, and monitor them from here without ever touching a terminal.",
      docUrl: docs.lanesStacks,
      placement: "bottom",
    },
    {
      target: '[data-tour="run.laneSelector"]',
      title: "Default lane",
      body: "Processes run inside a lane's worktree. Pick which lane gets new process runs here — you can override it per-command on the card.",
      docUrl: docs.lanesStacks,
      placement: "bottom",
    },
    {
      target: '[data-tour="run.stackTabs"]',
      title: "Stacks",
      body: "A Stack is a named group of commands you always run together — like \"dev\", \"test\", or \"deploy\". Click a tab to filter to its commands, then hit Run stack.",
      docUrl: docs.lanesStacks,
      placement: "bottom",
    },
    {
      target: '[data-tour="run.addCommand"]',
      title: "Add a command",
      body: "Define a new process — give it a name, a shell command, environment variables, a restart policy, and a readiness check. It shows up as a card immediately.",
      docUrl: docs.lanesStacks,
      placement: "bottom",
    },
    {
      target: '[data-tour="run.commandCards"]',
      title: "Command cards",
      body: "Each card is one process definition. The Play button starts a fresh run; the status badge and elapsed timer reflect the latest run. Click the card to edit.",
      docUrl: docs.lanesStacks,
      placement: "top",
    },
    {
      target: '[data-tour="run.runtimeBar"]',
      title: "Runtime bar",
      body: "Live health checks, preview URLs, and port leases for the active lane appear here so you can open your app in one click.",
      docUrl: docs.lanesStacks,
      placement: "bottom",
    },
    {
      target: '[data-tour="run.processMonitor"]',
      title: "Process monitor",
      body: "The monitor at the bottom streams live output from every running process and open shell. Click a tab to focus it, or hit Kill to terminate the run.",
      docUrl: docs.lanesStacks,
      placement: "top",
    },
  ],
};

registerTour(runTour);

export default runTour;
