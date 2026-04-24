import { registerTour, type Tour } from "../registry";

export const automationsTour: Tour = {
  id: "automations",
  title: "Automations walkthrough",
  route: "/automations",
  steps: [],
};

registerTour(automationsTour);

export default automationsTour;
