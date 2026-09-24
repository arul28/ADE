/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppBannerHost } from "./AppBannerHost";
import type { BannerModel } from "./Banner";
import {
  APP_BANNER_PRIORITY,
  getAppBannerEntries,
  resetAppBannersForTests,
  useAppBanners,
  type AppBannerOptions,
} from "./appBannerStore";

type Item = { model: BannerModel; options?: AppBannerOptions };

function Owner({ items }: { items: Item[] }): null {
  useAppBanners(items);
  return null;
}

function banner(id: string, overrides: Partial<BannerModel> = {}): BannerModel {
  return { id, tone: "warning", title: `Banner ${id}`, ...overrides };
}

function dockedIds(): string[] {
  const dock = screen.queryByTestId("app-banner-dock");
  if (!dock) return [];
  return Array.from(dock.querySelectorAll("[data-banner-id]")).map((el) => el.getAttribute("data-banner-id") ?? "");
}

describe("AppBannerHost", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAppBannersForTests();
  });

  afterEach(() => {
    cleanup();
    resetAppBannersForTests();
  });

  it("renders nothing when no banner is registered", () => {
    render(<AppBannerHost />);
    expect(screen.queryByTestId("app-banner-dock")).toBeNull();
    expect(screen.queryByTestId("app-banner-floating")).toBeNull();
  });

  it("orders docked banners by priority band, then tone, then registration", () => {
    render(
      <>
        <Owner
          items={[
            { model: banner("app-warning"), options: { priority: APP_BANNER_PRIORITY.app } },
            { model: banner("project-info", { tone: "info" }), options: { priority: APP_BANNER_PRIORITY.project } },
            { model: banner("project-error", { tone: "error" }), options: { priority: APP_BANNER_PRIORITY.project } },
            { model: banner("project-info-2", { tone: "info" }), options: { priority: APP_BANNER_PRIORITY.project } },
          ]}
        />
        <AppBannerHost />
      </>,
    );

    // Cap of two: the rest fold behind the toggle.
    expect(dockedIds()).toEqual(["project-error", "project-info"]);

    fireEvent.click(screen.getByRole("button", { name: "2 more notices" }));
    expect(dockedIds()).toEqual(["project-error", "project-info", "project-info-2", "app-warning"]);

    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(dockedIds()).toEqual(["project-error", "project-info"]);
  });

  it("keeps the account banner first even when it registers last behind a full dock", () => {
    const { rerender } = render(
      <>
        <Owner
          items={[
            { model: banner("relay", { tone: "error" }), options: { priority: APP_BANNER_PRIORITY.integration } },
            { model: banner("update", { tone: "error" }), options: { priority: APP_BANNER_PRIORITY.app } },
            { model: banner("missing", { tone: "error" }), options: { priority: APP_BANNER_PRIORITY.project } },
          ]}
        />
        <Owner items={[]} />
        <AppBannerHost />
      </>,
    );

    rerender(
      <>
        <Owner
          items={[
            { model: banner("relay", { tone: "error" }), options: { priority: APP_BANNER_PRIORITY.integration } },
            { model: banner("update", { tone: "error" }), options: { priority: APP_BANNER_PRIORITY.app } },
            { model: banner("missing", { tone: "error" }), options: { priority: APP_BANNER_PRIORITY.project } },
          ]}
        />
        <Owner items={[{ model: banner("account-signed_out"), options: { priority: APP_BANNER_PRIORITY.account } }]} />
        <AppBannerHost />
      </>,
    );

    expect(dockedIds()[0]).toBe("account-signed_out");
    expect(screen.getByRole("button", { name: "2 more notices" })).toBeTruthy();
  });

  it("hides a durably dismissed banner and resurfaces it when the fingerprint changes", () => {
    const withFingerprint = (fingerprint: string): Item[] => [
      { model: banner("relay", { dismiss: { key: "relay-offline", fingerprint } }) },
    ];
    const { rerender } = render(
      <>
        <Owner items={withFingerprint("down")} />
        <AppBannerHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss: Banner relay" }));
    expect(dockedIds()).toEqual([]);
    expect(window.localStorage.getItem("ade.bannerDismiss.v1")).toContain("relay-offline");

    // Same state re-registered: stays dismissed.
    rerender(
      <>
        <Owner items={withFingerprint("down")} />
        <AppBannerHost />
      </>,
    );
    expect(dockedIds()).toEqual([]);

    // A different state is a new problem: it comes back.
    rerender(
      <>
        <Owner items={withFingerprint("suppressed")} />
        <AppBannerHost />
      </>,
    );
    expect(dockedIds()).toEqual(["relay"]);
  });

  it("hands an owner-managed dismiss back to the owner", () => {
    const onDismiss = vi.fn();
    render(
      <>
        <Owner items={[{ model: banner("brain", { dismiss: { onDismiss, title: "Dismiss this" } }) }]} />
        <AppBannerHost />
      </>,
    );

    fireEvent.click(screen.getByTitle("Dismiss this"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("draws floating banners at the top center, apart from the dock, at most two", () => {
    render(
      <>
        <Owner
          items={[
            { model: banner("docked") },
            { model: banner("clip", { tone: "accent" }), options: { placement: "floating", priority: APP_BANNER_PRIORITY.prompt } },
            { model: banner("pr", { tone: "accent" }), options: { placement: "floating", priority: APP_BANNER_PRIORITY.prompt } },
            { model: banner("third", { tone: "accent" }), options: { placement: "floating", priority: APP_BANNER_PRIORITY.prompt } },
          ]}
        />
        <AppBannerHost />
      </>,
    );

    const floating = screen.getByTestId("app-banner-floating");
    const floatingIds = Array.from(floating.querySelectorAll("[data-banner-id]")).map((el) =>
      el.getAttribute("data-banner-id"),
    );
    expect(floatingIds).toEqual(["clip", "pr"]);
    expect(floating.querySelector("[data-banner-layout='floating']")).toBeTruthy();
    expect(dockedIds()).toEqual(["docked"]);
  });

  it("unregisters everything an owner raised when it unmounts", () => {
    const { rerender } = render(
      <>
        <Owner items={[{ model: banner("a") }, { model: banner("b") }]} />
        <AppBannerHost />
      </>,
    );
    expect(dockedIds()).toEqual(["a", "b"]);

    rerender(<AppBannerHost />);
    expect(dockedIds()).toEqual([]);
    expect(getAppBannerEntries()).toHaveLength(0);
  });

  it("drops a banner the owner stops registering (e.g. a project switch)", () => {
    const { rerender } = render(
      <>
        <Owner items={[{ model: banner("project-missing") }]} />
        <AppBannerHost />
      </>,
    );
    rerender(
      <>
        <Owner items={[]} />
        <AppBannerHost />
      </>,
    );
    expect(dockedIds()).toEqual([]);
  });

  it("lets a second owner take over an id without the first owner's unmount removing it", () => {
    function Pair({ showFirst }: { showFirst: boolean }) {
      return (
        <>
          {showFirst ? <Owner items={[{ model: banner("shared", { title: "From first" }) }]} /> : null}
          <Owner items={[{ model: banner("shared", { title: "From second" }) }]} />
          <AppBannerHost />
        </>
      );
    }
    const { rerender } = render(<Pair showFirst />);

    const dock = screen.getByTestId("app-banner-dock");
    expect(within(dock).getAllByText(/From (first|second)/)).toHaveLength(1);
    expect(within(dock).getByText("From second")).toBeTruthy();

    rerender(<Pair showFirst={false} />);
    expect(screen.getByText("From second")).toBeTruthy();
    expect(getAppBannerEntries()).toHaveLength(1);
  });

  it("runs the owner's latest action closure", () => {
    const first = vi.fn();
    const second = vi.fn();
    const item = (onClick: () => void): Item[] => [{ model: banner("x", { actions: [{ label: "Go", onClick }] }) }];
    const { rerender } = render(
      <>
        <Owner items={item(first)} />
        <AppBannerHost />
      </>,
    );
    rerender(
      <>
        <Owner items={item(second)} />
        <AppBannerHost />
      </>,
    );

    act(() => {
      screen.getByRole("button", { name: "Go" }).click();
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
