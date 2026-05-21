import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const laneWorkPaneTour: Tour = {
  id: "lane-work-pane",
  title: "Lane work pane walkthrough",
  route: "/lanes",
  steps: [
    {
      target: '[data-tour="work.viewArea"]',
      title: "Lane work surface",
      body: "This is where work runs inside the selected lane — AI chats, CLI tools, and terminals all appear here in this lane's copy of the project.",
      docUrl: docs.chatOverview,
      placement: "top",
    },
    {
      target: '[data-tour="work.focusToolbar"]',
      title: "Tabs and layout",
      body: "Switch between open sessions, change tab vs grid layout, and focus the session you want to work in.",
      docUrl: docs.chatOverview,
      placement: "bottom",
    },
  ],
};

registerTour(laneWorkPaneTour);

export default laneWorkPaneTour;
