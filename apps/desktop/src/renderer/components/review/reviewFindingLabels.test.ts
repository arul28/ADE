import { describe, expect, it } from "vitest";
import { reviewPublicationLabel } from "./reviewFindingLabels";

describe("reviewFindingLabels", () => {
  it("distinguishes strong local findings from local-only findings", () => {
    expect(reviewPublicationLabel({
      publicationState: "local_only",
      adjudication: {
        score: 0.8,
        candidateCount: 1,
        mergedFindingIds: ["candidate-1"],
        rationale: "Strong evidence.",
        publicationEligible: true,
      },
    }).label).toBe("Strong evidence");

    expect(reviewPublicationLabel({
      publicationState: "local_only",
      adjudication: {
        score: 0.4,
        candidateCount: 1,
        mergedFindingIds: ["candidate-2"],
        rationale: "Kept local.",
        publicationEligible: false,
      },
    }).label).toBe("Saved locally");
  });
});
