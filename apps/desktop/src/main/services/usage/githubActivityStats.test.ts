import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calendarResponse = JSON.stringify({ data: { viewer: { contributionsCollection: {
  contributionCalendar: { totalContributions: 7, weeks: [{ contributionDays: [
    { date: "2026-10-08", contributionCount: 3 },
    { date: "2026-10-09", contributionCount: 4 },
  ] }] },
} } } });

describe("GitHub contribution calendar", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces concurrent gh reads and caches a successful calendar for an hour", async () => {
    const { readGithubContributionCalendar } = await import("./githubActivityStats");
    let resolve!: (value: string) => void;
    const runCommand = vi.fn((_command: string, _args: string[]) => new Promise<string>((done) => { resolve = done; }));
    const first = readGithubContributionCalendar(runCommand);
    const second = readGithubContributionCalendar(runCommand);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0]).toEqual(expect.arrayContaining(["gh", expect.arrayContaining(["api", "graphql"])]));
    resolve(calendarResponse);
    const [calendar, concurrent] = await Promise.all([first, second]);
    expect(calendar).toMatchObject({ total: 7, days: [
      { date: "2026-10-08", count: 3 }, { date: "2026-10-09", count: 4 },
    ] });
    expect(concurrent).toEqual(calendar);
    runCommand.mockResolvedValue(calendarResponse);
    vi.advanceTimersByTime(60 * 60_000 - 1);
    await readGithubContributionCalendar(runCommand);
    expect(runCommand).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await readGithubContributionCalendar(runCommand);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("returns null on gh failure and retries after five minutes", async () => {
    const { readGithubContributionCalendar } = await import("./githubActivityStats");
    const runCommand = vi.fn().mockRejectedValueOnce(new Error("gh is not signed in"))
      .mockResolvedValue(calendarResponse);
    await expect(readGithubContributionCalendar(runCommand)).resolves.toBeNull();
    vi.advanceTimersByTime(5 * 60_000 - 1);
    await expect(readGithubContributionCalendar(runCommand)).resolves.toBeNull();
    expect(runCommand).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await expect(readGithubContributionCalendar(runCommand)).resolves.toMatchObject({ total: 7 });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});
