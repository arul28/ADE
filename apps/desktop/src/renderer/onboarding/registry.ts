export type TourStepPlacement = "top" | "bottom" | "left" | "right" | "auto";

export type TourStep = {
  target: string;
  title: string;
  body: string;
  docUrl?: string;
  placement?: TourStepPlacement;
  waitForSelector?: string;
  beforeEnter?: () => void;
};

export type Tour = {
  id: string;
  title: string;
  route: string;
  steps: TourStep[];
};

const tours: Tour[] = [];

export function registerTour(tour: Tour): void {
  const idx = tours.findIndex((t) => t.id === tour.id);
  if (idx >= 0) {
    tours[idx] = tour;
    return;
  }
  tours.push(tour);
}

export function getTour(id: string): Tour | undefined {
  return tours.find((t) => t.id === id);
}

export function listTours(): Tour[] {
  return tours.slice();
}

export function _resetRegistryForTests(): void {
  tours.length = 0;
}
