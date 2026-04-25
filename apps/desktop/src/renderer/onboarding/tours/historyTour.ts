import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const historyTour: Tour = {
  id: "history",
  title: "History walkthrough",
  route: "/history",
  steps: [
    {
      target: '[data-tour="history.entries"]',
      title: "What just happened",
      body: "The newest events sit at the top: lanes you made, work you saved, things you shipped, AI tasks that finished. Scroll to see further back.",
      docUrl: docs.historyOverview,
      placement: "right",
    },
    {
      target: '[data-tour="history.filter"]',
      title: "Find specific moments",
      body: "When the list gets long, filter to just the big stuff or just one type of event so you don't have to scroll forever.",
      docUrl: docs.historyOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="history.export"]',
      title: "Show what matters to you",
      body: "Choose which details show up next to each event — timestamps, who did it, which lane. Hide the noise, keep what's useful.",
      docUrl: docs.historyOverview,
      placement: "bottom",
    },
  ],
};

registerTour(historyTour);

export default historyTour;
