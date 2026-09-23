import { describe, expect, it } from "vitest";
import {
  formatProofClockRange,
  proofRecordedBeforeRequestLine,
  proofSourceLine,
  readProofProvenance,
} from "./proofProvenance";

// Local wall-clock times, so the output does not depend on the time zone.
const at = (hour: number, minute: number) => new Date(2026, 8, 23, hour, minute).toISOString();
// Intl may put a narrow no-break space before AM/PM; compare on plain spaces.
const plain = (text: string | null) => text?.replace(/\s/gu, " ") ?? null;

describe("proof provenance", () => {
  it("reads only the values the broker writes", () => {
    expect(readProofProvenance({ proofSource: "ade-recorder", recordedFrom: at(10, 24), recordedBeforeRequest: true }))
      .toMatchObject({ source: "ade-recorder", recordedFrom: at(10, 24), recordedTo: null, recordedBeforeRequest: true });
    expect(readProofProvenance({ proofSource: "someone", recordedFrom: "not a date", recordedBeforeRequest: "yes" }))
      .toEqual({ source: null, recordedFrom: null, recordedTo: null, mediaCreatedAt: null, recordedBeforeRequest: false });
    expect(readProofProvenance(null).source).toBeNull();
  });

  it("writes the source line for each source, and nothing for an old row", () => {
    const recorded = readProofProvenance({ proofSource: "ade-recorder", recordedFrom: at(10, 24), recordedTo: at(10, 25) });
    expect(plain(proofSourceLine(recorded, "en-US"))).toBe("Recorded by ADE · 10:24–10:25 AM");
    expect(plain(proofSourceLine(readProofProvenance({ proofSource: "ade-recorder" }), "en-US"))).toBe("Recorded by ADE");
    expect(proofSourceLine(readProofProvenance({ proofSource: "ade-capture" }))).toBe("Captured by ADE");
    expect(proofSourceLine(readProofProvenance({ proofSource: "attached" }))).toBe("Attached by the agent");
    expect(proofSourceLine(readProofProvenance({}))).toBeNull();
  });

  it("says a day period once, keeps two different ones, and has none in 24-hour time", () => {
    expect(plain(formatProofClockRange(at(11, 58), at(12, 2), "en-US"))).toBe("11:58 AM–12:02 PM");
    expect(plain(formatProofClockRange(at(10, 24), at(10, 24), "en-US"))).toBe("10:24 AM");
    expect(formatProofClockRange(at(10, 24), at(10, 25), "en-GB")).toBe("10:24–10:25");
  });

  it("writes the older line only when flagged", () => {
    const flagged = readProofProvenance({ mediaCreatedAt: at(5, 19), recordedBeforeRequest: true });
    expect(plain(proofRecordedBeforeRequestLine(flagged, "en-US"))).toBe("Recorded at 5:19 AM, before this request.");
    expect(proofRecordedBeforeRequestLine(readProofProvenance({ mediaCreatedAt: at(5, 19) }))).toBeNull();
  });
});
