import { registerTour, type Tour } from "../registry";

export const prsTour: Tour = {
  id: "prs",
  title: "Pull Requests tour",
  route: "/prs",
  steps: [],
};

registerTour(prsTour);

export default prsTour;
