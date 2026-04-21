import { registerTour, type Tour } from "../registry";

export const settingsTour: Tour = {
  id: "settings",
  title: "Settings tour",
  route: "/settings",
  steps: [],
};

registerTour(settingsTour);

export default settingsTour;
