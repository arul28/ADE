import { registerTour, type Tour } from "../registry";

export const graphTour: Tour = {
  id: "graph",
  title: "Graph tour",
  route: "/graph",
  steps: [],
};

registerTour(graphTour);

export default graphTour;
