import { describe, expect, it } from "vitest";
import { summarizeDroidAskUser } from "./droidSdkAskUser";

describe("summarizeDroidAskUser", () => {
  it("preserves raw Droid option values while trimming display labels", () => {
    const request = summarizeDroidAskUser({
      toolCallId: "tool-ask-1",
      questions: [
        {
          index: 7,
          topic: "  Deploy choice  ",
          question: "Which exact option should Droid receive?",
          options: [" yes ", "no", "", "   "],
        },
      ],
    } as any);

    expect(request.questions).toEqual([
      {
        id: "q_7",
        header: "Deploy choice",
        question: "Which exact option should Droid receive?",
        options: [
          { label: "yes", value: " yes " },
          { label: "no", value: "no" },
        ],
      },
    ]);
  });
});
