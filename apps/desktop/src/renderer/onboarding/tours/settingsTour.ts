import { registerTour, type Tour } from "../registry";

export const settingsTour: Tour = {
  id: "settings",
  title: "Settings walkthrough",
  route: "/settings",
  steps: [],
};

registerTour(settingsTour);

export default settingsTour;
