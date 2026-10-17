/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComputerUseArtifactView } from "../../../shared/types";
import type * as ChatRuntimeScopeModule from "./ChatRuntimeScope";
import { CitedProofSlot } from "./ChatProofCitation";

const scopeState = vi.hoisted(() => ({ online: true }));

vi.mock("./ChatRuntimeScope", async (importOriginal) => ({
  ...(await importOriginal<typeof ChatRuntimeScopeModule>()),
  useChatRuntimeScope: () => ({
    pin: null,
    rootPath: null,
    isRemote: false,
    machineName: "This computer",
    online: scopeState.online,
  }),
}));

/**
 * A cited proof has three answers, and the citation must not blur them: the
 * machine has the record (ready), the machine says there is no such record
 * (missing), or the machine could not be asked (unreadable). Only the second
 * may say "ADE has no proof".
 */

const READY: ComputerUseArtifactView = {
  id: "art-ready",
  kind: "screenshot",
  title: "Before the fix",
  description: null,
  uri: ".ade/artifacts/computer-use/before-the-fix.png",
  mimeType: "image/png",
  metadata: {},
  availability: "available",
} as unknown as ComputerUseArtifactView;

function stubAde(listArtifacts: (args: { artifactId: string }) => Promise<unknown[]>) {
  const computerUse = {
    listArtifacts: vi.fn(listArtifacts),
    readArtifactPreview: vi.fn(async () => "data:image/png;base64,AAAA"),
    mediaBaseUrl: vi.fn(async () => null),
  };
  (window as unknown as { ade: unknown }).ade = { computerUse };
  return computerUse;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
  scopeState.online = true;
});

describe("CitedProofSlot", () => {
  it("shows the proof when the machine has it", async () => {
    stubAde(async () => [READY]);

    render(<CitedProofSlot artifactId="art-ready" caption="Before the fix" />);

    expect(await screen.findByRole("img", { name: "Before the fix" })).toBeTruthy();
    expect(screen.queryByText(/ADE has no proof/)).toBeNull();
  });

  it("says there is no proof only when the machine answers with none", async () => {
    stubAde(async () => []);

    render(<CitedProofSlot artifactId="art-missing" caption="Gone" />);

    expect(await screen.findByText("ADE has no proof with the id art-missing. It was cited as \"Gone\".")).toBeTruthy();
  });

  it("says it could not load the proof when the machine could not be asked", async () => {
    stubAde(async () => {
      throw new Error("host_unavailable");
    });

    render(<CitedProofSlot artifactId="art-unreachable" caption="Gone" />);

    expect(await screen.findByText("Couldn't load this proof from this computer. It was cited as \"Gone\".")).toBeTruthy();
    expect(screen.queryByText(/ADE has no proof/)).toBeNull();
  });

  it("asks again on the next mount after a failed read, instead of keeping the failure", async () => {
    let answer: "fail" | "ready" = "fail";
    stubAde(async () => {
      if (answer === "fail") throw new Error("disconnected");
      return [{ ...READY, id: "art-retry" }];
    });

    const first = render(<CitedProofSlot artifactId="art-retry" caption="Retry" />);
    expect(await screen.findByText(/Couldn't load this proof/)).toBeTruthy();
    first.unmount();

    answer = "ready";
    render(<CitedProofSlot artifactId="art-retry" caption="Retry" />);
    expect(await screen.findByRole("img", { name: "Retry" })).toBeTruthy();
  });

  it("asks again when the pinned machine comes back online after a failed read", async () => {
    let answer: "fail" | "ready" = "fail";
    const computerUse = stubAde(async () => {
      if (answer === "fail") throw new Error("host_unavailable");
      return [{ ...READY, id: "art-back" }];
    });
    scopeState.online = false;

    const view = render(<CitedProofSlot artifactId="art-back" caption="Back" />);
    expect(await screen.findByText(/Couldn't load this proof/)).toBeTruthy();
    expect(computerUse.listArtifacts).toHaveBeenCalledTimes(1);

    answer = "ready";
    scopeState.online = true;
    view.rerender(<CitedProofSlot artifactId="art-back" caption="Back" />);

    expect(await screen.findByRole("img", { name: "Back" })).toBeTruthy();
    expect(computerUse.listArtifacts).toHaveBeenCalledTimes(2);
  });
});
