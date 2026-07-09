import { describe, expect, it } from "vitest";
import { cronSentence, describeCron } from "./cronDescribe";

describe("describeCron", () => {
  it("describes weekday morning schedules", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("every weekday at 9:00am");
  });

  it("describes every-day schedules", () => {
    expect(describeCron("0 9 * * *")).toBe("every day at 9:00am");
    expect(describeCron("0 2 * * *")).toBe("every day at 2:00am");
  });

  it("describes a single weekday afternoon", () => {
    expect(describeCron("0 16 * * 5")).toBe("every Friday at 4:00pm");
    expect(describeCron("30 8 * * 1")).toBe("every Monday at 8:30am");
  });

  it("treats 0 and 7 as Sunday and pairs weekend days", () => {
    expect(describeCron("0 10 * * 0,6")).toBe("every weekend day at 10:00am");
    expect(describeCron("0 10 * * 7")).toBe("every Sunday at 10:00am");
  });

  it("describes minute and hour intervals", () => {
    expect(describeCron("*/15 * * * *")).toBe("every 15 minutes");
    expect(describeCron("*/1 * * * *")).toBe("every minute");
    expect(describeCron("0 * * * *")).toBe("every hour, on the hour");
    expect(describeCron("0 */2 * * *")).toBe("every 2 hours");
  });

  it("describes day-of-month schedules", () => {
    expect(describeCron("0 0 1 * *")).toBe("on day 1 of every month at 12:00am");
  });

  it("falls back to the raw expression when unparseable", () => {
    expect(describeCron("bogus cron here now")).toBe("at bogus cron here now");
    expect(describeCron("0 9 * *")).toBe("at 0 9 * *");
  });

  it("handles empty input", () => {
    expect(describeCron("")).toBe("No schedule set");
    expect(describeCron(null)).toBe("No schedule set");
  });

  it("capitalizes for sentence use", () => {
    expect(cronSentence("0 9 * * 1-5")).toBe("Every weekday at 9:00am");
  });
});
