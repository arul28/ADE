import { describe, expect, it } from "vitest";
import {
  formatProofClockRange,
  formatProofDuration,
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
      .toEqual({ source: null, recordedFrom: null, recordedTo: null, mediaCreatedAt: null, recordedBeforeRequest: false, idleCutMs: null });
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

  it("says how much still time the recorder cut, and only when it cut a second or more", () => {
    const cut = readProofProvenance({ proofSource: "ade-recorder", recordedFrom: at(10, 24), recordedTo: at(10, 27), idleCutMs: 127_000 });
    expect(plain(proofSourceLine(cut, "en-US"))).toBe("Recorded by ADE · 10:24–10:27 AM · idle cut 2:07");
    expect(proofSourceLine(readProofProvenance({ proofSource: "ade-recorder", idleCutMs: 400 }))).toBe("Recorded by ADE");
    expect(readProofProvenance({ idleCutMs: "lots" }).idleCutMs).toBeNull();
  });

  // Same cases as the phone's `workProofDuration`.
  it("formats a duration as m:ss, or h:mm:ss from an hour", () => {
    expect(formatProofDuration(23_000)).toBe("0:23");
    expect(formatProofDuration(3_842_000)).toBe("1:04:02");
    expect(formatProofDuration(59_600)).toBe("1:00");
    expect(formatProofDuration(-5_000)).toBe("0:00");
  });

  it("says a day period once, keeps two different ones, and has none in 24-hour time", () => {
    expect(plain(formatProofClockRange(at(11, 58), at(12, 2), "en-US"))).toBe("11:58 AM–12:02 PM");
    expect(plain(formatProofClockRange(at(10, 24), at(10, 24), "en-US"))).toBe("10:24 AM");
    expect(formatProofClockRange(at(10, 24), at(10, 25), "en-GB")).toBe("10:24–10:25");
    // A dotted period is kept whole: not "10:24 a.–10:25 a.m.".
    expect(plain(formatProofClockRange(at(10, 24), at(10, 25), "en-CA"))).toBe("10:24–10:25 a.m.");
    expect(plain(formatProofClockRange(at(10, 24), at(13, 25), "en-CA"))).toBe("10:24 a.m.–1:25 p.m.");
  });

  it("writes the older line only when flagged", () => {
    const flagged = readProofProvenance({ mediaCreatedAt: at(5, 19), recordedBeforeRequest: true });
    expect(plain(proofRecordedBeforeRequestLine(flagged, "en-US"))).toBe("Recorded at 5:19 AM, before this request.");
    expect(proofRecordedBeforeRequestLine(readProofProvenance({ mediaCreatedAt: at(5, 19) }))).toBeNull();
  });
});
