/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BackgroundJobRunRow } from "./BackgroundJobRunRow";
import { describeScheduledWorkLine, ScheduledWorkLine } from "./ScheduledWorkLine";
import type { BackgroundJobGroupMember, BackgroundJobLineRenderEvent } from "./chatTranscriptRows";

afterEach(cleanup);

function member(id: string, label: string, status: BackgroundJobLineRenderEvent["status"], durationMs = 180_000): BackgroundJobGroupMember {
  const event: BackgroundJobLineRenderEvent = status === "running"
    ? { type: "background_job_line", agentKey: id, label, startedAt: "2026-09-23T12:00:00.000Z", taskId: id, status }
    : { type: "background_job_line", agentKey: id, label, startedAt: "2026-09-23T12:00:00.000Z", taskId: id, status, exitCode: null, durationMs };
  return { key: `background-chip:${id}`, timestamp: "2026-09-23T12:00:00.000Z", event };
}

const fiveJobs = () => [
  member("a", "Search kimi binary for session file patterns", "completed"),
  member("b", "Find kimi session dir helpers and meta file names", "failed", 1_000),
  member("c", "Find kimi session dir helpers and meta files", "completed", 120_000),
  member("d", "Print kimi session dir helper bodies", "running"),
  member("e", "Print kimi session meta and index helpers", "completed", 4_000),
];

describe("BackgroundJobRunRow", () => {
  it("reads a single job as one line with its duration and status", () => {
    const { container } = render(<BackgroundJobRunRow members={[member("a", "Search kimi binary for session file patterns", "completed")]} />);
    const row = container.querySelector("[data-background-job]")!;
    expect(row.textContent).toBe("$Search kimi binary for session file patterns· 3m· done");
    // No host pane, no Stop target: nothing clickable that would do nothing.
    expect(container.querySelector("button")).toBeNull();
  });

  it("summarizes a run in one row, failed count in red, and lists every job on click", () => {
    const onOpenJob = vi.fn();
    const onStop = vi.fn();
    render(<BackgroundJobRunRow members={fiveJobs()} sessionEnded onOpenJob={onOpenJob} onStop={onStop} />);
    const header = screen.getByRole("button", { name: /5 background jobs/ });
    expect(header.textContent).toBe("$5 background jobs· 1 running· 3 done· 1 failed");
    expect(screen.getByTestId("background-jobs-failed").className).toContain("text-red-400");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Print kimi session dir helper bodies")).toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    const items = document.querySelectorAll("li[data-background-job]");
    expect([...items].map((item) => item.getAttribute("data-background-job-status")))
      .toEqual(["completed", "failed", "completed", "running", "completed"]);
    expect(items[1]!.textContent).toContain("1s");
    expect(items[1]!.textContent).toContain("failed");

    fireEvent.click(screen.getByRole("button", { name: "Open Find kimi session dir helpers and meta files in the chat actions pane" }));
    expect(onOpenJob).toHaveBeenCalledWith("c");
    // The ended session's running job cannot be stopped from here.
    expect(screen.queryByRole("button", { name: /^Stop / })).toBeNull();
  });

  it("stops a running job by provider task id", () => {
    const onStop = vi.fn();
    render(<BackgroundJobRunRow members={[member("d", "npm run dev", "running")]} onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop npm run dev" }));
    expect(onStop).toHaveBeenCalledWith("d");
  });

  it("keeps the mouse-focus outline off its controls", () => {
    render(<BackgroundJobRunRow members={fiveJobs()} />);
    const header = screen.getByRole("button", { name: /5 background jobs/ });
    expect(header.className).toContain("focus:outline-none");
    expect(header.className).toContain("focus-visible:ring-1");
  });
});

describe("ScheduledWorkLine", () => {
  const now = Date.parse("2026-09-23T14:10:00.000Z");
  const base = {
    type: "scheduled_work_update" as const,
    id: "wake-1",
    turnId: "t1",
  };

  it("words a pending wake-up, a fired one, and a cron", () => {
    expect(describeScheduledWorkLine({ ...base, kind: "wakeup", status: "scheduled", nextRunAt: "2026-09-23T14:30:00.000Z" }, now))
      .toMatchObject({ kind: "wake", head: "Wakes in 20m", pending: true });
    expect(describeScheduledWorkLine({ ...base, kind: "wakeup", status: "fired", firedAt: "2026-09-23T14:30:00.000Z" }, now).head)
      .toMatch(/^Woke at /);
    const cron = describeScheduledWorkLine({ ...base, kind: "cron", status: "scheduled", cron: "*/30 * * * *", nextRunAt: "2026-09-23T14:30:00.000Z" }, now);
    expect(cron.kind).toBe("repeat");
    expect(cron.head).toMatch(/^Cron · every 30m · next /);
    expect(describeScheduledWorkLine({ ...base, kind: "cron", status: "cancelled", cron: "0 * * * *" }, now).head)
      .toBe("Cron · every hour, on the hour · cancelled");
  });

  it("renders one line that opens the actions pane", () => {
    const onOpen = vi.fn();
    render(<ScheduledWorkLine event={{ ...base, kind: "wakeup", status: "scheduled", nextRunAt: new Date(Date.now() + 20 * 60_000 + 5_000).toISOString(), reason: "check CI" }} onOpen={onOpen} />);
    const line = screen.getByRole("button");
    expect(line.textContent).toBe("Wakes in 20m· check CI");
    fireEvent.click(line);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
