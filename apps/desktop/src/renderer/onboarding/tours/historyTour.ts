import { registerTour, type Tour } from "../registry";

export const historyTour: Tour = {
  id: "history",
  title: "History walkthrough",
  route: "/history",
  steps: [],
};

registerTour(historyTour);

export default historyTour;
