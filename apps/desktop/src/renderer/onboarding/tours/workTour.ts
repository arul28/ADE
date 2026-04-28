import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

// The work.sessionItem anchor only mounts once a session card is rendered, so
// it's covered by the tutorial's interactive `act4.newSession` step rather than
// this passive walkthrough.
export const workTour: Tour = {
  id: "work",
  title: "Work tab walkthrough",
  route: "/work",
  steps: [
    {
      target: '[data-tour="work.sessionsPane"]',
      title: "Every conversation in one list",
      body: "All your AI chats and terminal windows show up here, no matter which lane they're in. Each one is called a **session** — just one open conversation or one open terminal.",
      docUrl: docs.chatOverview,
      placement: "right",
    },
    {
      target: '[data-tour="work.laneFilter"]',
      title: "Narrow the list",
      body: "Got a lot going on? Filter the list down to just one lane's conversations. Useful once you have AI working in several lanes at once.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.newSession"]',
      title: "Start a new conversation",
      body: "Open a new AI chat, command-line tool, or terminal window. The new session attaches to whichever lane you pick — and only sees that lane's files.",
      docUrl: docs.chatOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.viewArea"]',
      title: "Where it all shows up",
      body: "Whatever you've opened — chats, terminals — appears here. Drag tabs to rearrange them, close one to clean up. The list on the left always shows everything, even closed ones.",
      docUrl: docs.terminals,
      placement: "left",
    },
  ],
};

registerTour(workTour);

export default workTour;
