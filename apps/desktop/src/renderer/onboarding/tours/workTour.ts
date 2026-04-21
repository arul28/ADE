import { registerTour, type Tour } from "../registry";

const DOCS = "https://www.ade-app.dev/docs";

export const workTour: Tour = {
  id: "work",
  title: "Work tab tour",
  route: "/lanes",
  steps: [
    {
      target: '[data-tour="work.toolbar"]',
      title: "Work toolbar",
      body: "This bar is your launchpad for every kind of session in the lane — chat, CLI tool, or raw shell.",
      docUrl: `${DOCS}/chat/overview`,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.entryOptions"]',
      title: "Start a new session",
      body: "Pick New Chat to talk to an AI Worker, CLI Tool for AI-assisted commands, or New Shell for a plain terminal inside this lane's worktree.",
      docUrl: `${DOCS}/chat/overview`,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.workNewChat"]',
      title: "AI chat",
      body: "New Chat opens a conversation with a Worker scoped to this lane. It can read files, run commands, and edit code on your behalf.",
      docUrl: `${DOCS}/chat/overview`,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.workCliTool"]',
      title: "CLI tool",
      body: "CLI Tool gives you AI-assisted command execution. Describe what you want and let the Worker construct and run the command.",
      docUrl: `${DOCS}/tools/terminals`,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.workNewShell"]',
      title: "Shell terminal",
      body: "New Shell drops you straight into a terminal whose working directory is this lane's worktree folder.",
      docUrl: `${DOCS}/tools/terminals`,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.laneName"]',
      title: "Lane context",
      body: "Every session here is scoped to this lane. Workers and shells see this lane's branch and files, not the primary workspace.",
      docUrl: `${DOCS}/lanes/overview`,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.sessionCount"]',
      title: "Open sessions",
      body: "This badge counts the sessions currently open in the Work pane. Click any tab in the view area below to switch between them.",
      docUrl: `${DOCS}/chat/overview`,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.viewArea"]',
      title: "Session view area",
      body: "All your open chats and terminals live here. Drag tabs to rearrange, or close one to reclaim space.",
      docUrl: `${DOCS}/chat/overview`,
      placement: "top",
    },
  ],
};

registerTour(workTour);

export default workTour;
