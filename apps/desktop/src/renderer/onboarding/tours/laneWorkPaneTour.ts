import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const laneWorkPaneTour: Tour = {
  id: "lane-work-pane",
  title: "Lane work pane walkthrough",
  route: "/lanes",
  steps: [
    {
      target: '[data-tour="work.toolbar"]',
      title: "The lane's command center",
      body: "This is where you start work *inside* a specific lane. Anything you launch from here — AI chats, scripts, terminals — runs in this lane's copy of the project, so it can't mess up your real one or any other lane.",
      docUrl: docs.chatOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.entryOptions"]',
      title: "Three ways to get help",
      body: "Three buttons start three kinds of helpers — an AI chat, a command-line AI tool, or a plain terminal. Pick the one that fits the kind of help you need.",
      docUrl: docs.chatOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.workNewChat"]',
      title: "AI chat",
      body: "Best for *\"please figure this out and do it\"* tasks. Example: *\"Why does the login screen flash on Safari? Find it and fix it in this lane.\"* The AI reads your files, makes changes, and shows you what it did.",
      docUrl: docs.chatOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.workCliTool"]',
      title: "Command-line AI tool",
      body: "Best when the work is command-shaped — running scripts, processing files. Example: *\"Run the tests for the files I changed and summarize what failed.\"*",
      docUrl: docs.terminals,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.workNewShell"]',
      title: "Plain terminal",
      body: "Just a regular terminal — no AI involved. Already pointed at this lane's folder, so commands you type only affect this lane's copy.",
      docUrl: docs.terminals,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.laneName"]',
      title: "A safety check",
      body: "This label tells you which lane you're inside. **Always glance here before starting a chat or running a command** — whatever you do affects this lane only. Switch lanes if you wanted a different one.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.sessionCount"]',
      title: "How busy is this lane?",
      body: "How many chats and terminals are open inside this lane right now. Zero is normal until you start something.",
      docUrl: docs.chatOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.viewArea"]',
      title: "Where it all shows up",
      body: "Once you start a chat or terminal, it appears here. If it's empty, that's fine — this lane just doesn't have anything running yet.",
      docUrl: docs.chatOverview,
      placement: "top",
    },
  ],
};

registerTour(laneWorkPaneTour);

export default laneWorkPaneTour;
