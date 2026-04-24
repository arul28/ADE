import { registerTour, type Tour } from "../registry";

export const missionsTour: Tour = {
  id: "missions",
  title: "Missions walkthrough",
  route: "/missions",
  steps: [],
};

registerTour(missionsTour);

export default missionsTour;
