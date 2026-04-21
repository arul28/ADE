import { registerTour, type Tour } from "../registry";

export const ctoTour: Tour = {
  id: "cto",
  title: "CTO tour",
  route: "/cto",
  steps: [],
};

registerTour(ctoTour);

export default ctoTour;
