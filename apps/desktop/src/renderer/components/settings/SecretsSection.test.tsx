/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SecretsSection } from "./SecretsSection";

const originalAde = (globalThis.window as any)?.ade;

function installAdeMock() {
  const list = vi.fn(async () => ({
    secrets: [{ name: "EXISTING", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", valueLength: 3 }],
    storage: { path: "/remote/.ade/secrets/project-secrets.v1.enc", encrypted: true, scope: "project" as const },
  }));
  const get = vi.fn(async () => ({ name: "EXISTING", value: "old", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", valueLength: 3 }));
  const importEnv = vi.fn<[], Promise<{ imported: string[]; replaced: string[] }>>(async () => ({
    imported: ["NEW_SECRET"],
    replaced: [],
  }));
  const exportEnv = vi.fn(async () => ({ filePath: "/Users/remote/Downloads/ade-secrets.env", secretCount: 1 }));
  const writeClipboardText = vi.fn(async () => undefined);
  (globalThis.window as any).ade = {
    app: { writeClipboardText },
    projectSecrets: {
      list,
      get,
      set: vi.fn(),
      delete: vi.fn(),
      chooseEnvFile: vi.fn(async () => ({
        fileName: ".env.local",
        secrets: [
          { name: "EXISTING", value: "replacement", exists: true },
          { name: "NEW_SECRET", value: "visible value", exists: false },
        ],
      })),
      importEnv,
      exportEnv,
    },
  };
  return { get, importEnv, exportEnv, writeClipboardText };
}

describe("SecretsSection env import and export", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalAde === undefined) delete (globalThis.window as any).ade;
    else (globalThis.window as any).ade = originalAde;
  });

  it("shows extracted values and imports only the selected secrets", async () => {
    const { importEnv } = installAdeMock();
    render(<SecretsSection />);

    await screen.findByText("EXISTING");
    fireEvent.click(screen.getByRole("button", { name: "Import .env" }));

    const dialog = await screen.findByRole("dialog", { name: /Import secrets from \.env\.local/ });
    expect(within(dialog).getByText("replacement")).toBeTruthy();
    expect(within(dialog).getByText("visible value")).toBeTruthy();
    expect(within(dialog).getByText("Replaces existing")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Clear all" }));
    const checkboxes = within(dialog).getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save 1 secret" }));

    await waitFor(() => expect(importEnv).toHaveBeenCalledWith({
      secrets: [{ name: "NEW_SECRET", value: "visible value" }],
    }));
    expect(await screen.findByText("Imported 1 secret.")).toBeTruthy();
  });

  it("requires plaintext confirmation and reports the remote machine Downloads path after export", async () => {
    const { exportEnv } = installAdeMock();
    render(<SecretsSection />);

    expect(await screen.findByText(/Export writes an unencrypted \.env file containing all project secret values/)).toBeTruthy();
    const button = await screen.findByRole("button", { name: "Export .env" });
    fireEvent.click(button);
    expect(exportEnv).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm plaintext export" }));

    await waitFor(() => expect(exportEnv).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/\/Users\/remote\/Downloads\/ade-secrets\.env on the active machine/)).toBeTruthy();
  });

  it("clears revealed and copied values when import replaces a secret", async () => {
    const { get, importEnv, writeClipboardText } = installAdeMock();
    get
      .mockResolvedValueOnce({ name: "EXISTING", value: "old", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", valueLength: 3 })
      .mockResolvedValueOnce({ name: "EXISTING", value: "replacement", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z", valueLength: 11 });
    importEnv.mockResolvedValueOnce({ imported: [], replaced: ["EXISTING"] });
    render(<SecretsSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Reveal EXISTING" }));
    expect(await screen.findByText("old")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import .env" }));

    const dialog = await screen.findByRole("dialog", { name: /Import secrets from \.env\.local/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear all" }));
    fireEvent.click(within(dialog).getAllByRole("checkbox")[0]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save 1 secret" }));

    expect(await screen.findByText("Imported 1 secret (1 replaced).")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reveal EXISTING" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy EXISTING" }));

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(writeClipboardText).toHaveBeenCalledWith("replacement");
  });
});
