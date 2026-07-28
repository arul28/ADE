/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptStashEntry } from "../../../shared/types";
import {
  ComposerPromptStash,
  type ComposerPromptStashHandle,
} from "./ComposerPromptStash";

const savedEntry: PromptStashEntry = {
  id: "stash-1",
  text: "Fix the parser",
  provider: "codex",
  modelId: "openai/gpt-5.4",
  createdAt: "2026-07-28T12:00:00.000Z",
};

function installBridge(overrides?: {
  list?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}) {
  const promptStashes = {
    list: overrides?.list ?? vi.fn().mockResolvedValue([]),
    create: overrides?.create ?? vi.fn().mockResolvedValue(savedEntry),
    delete: overrides?.delete ?? vi.fn().mockResolvedValue(true),
  };
  (window as unknown as { ade: unknown }).ade = {
    agentChat: { promptStashes },
  };
  return promptStashes;
}

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("ComposerPromptStash", () => {
  it("clears only after the runtime durably saves the prompt", async () => {
    const create = vi.fn().mockResolvedValue(savedEntry);
    const bridge = installBridge({ create });
    const onDraftChange = vi.fn();
    render(
      <ComposerPromptStash
        draft="Fix the parser"
        provider="codex"
        modelId="openai/gpt-5.4"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      text: "Fix the parser",
      provider: "codex",
      modelId: "openai/gpt-5.4",
    }));
    expect(onDraftChange).toHaveBeenCalledWith("");
    expect(bridge.list).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft intact and explains a failed save", async () => {
    installBridge({
      create: vi.fn().mockRejectedValue(new Error("Runtime unavailable")),
    });
    const onDraftChange = vi.fn();
    render(
      <ComposerPromptStash
        draft="Do not lose this"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Runtime unavailable");
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("restores a shared stash as a take operation", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    installBridge({
      list: vi.fn().mockResolvedValue([savedEntry]),
      delete: remove,
    });
    const onDraftChange = vi.fn();
    render(
      <ComposerPromptStash
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 stashed prompt" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/i }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith({ id: "stash-1" }));
    expect(onDraftChange).toHaveBeenCalledWith("Fix the parser");
    expect(screen.queryByText("Stashed prompts")).toBeNull();
  });

  it("closes the stash menu without consuming an entry when the user starts a new draft", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    installBridge({
      list: vi.fn().mockResolvedValue([savedEntry]),
      delete: remove,
    });
    const onDraftChange = vi.fn();
    const view = render(
      <ComposerPromptStash
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 stashed prompt" }));
    expect(screen.getByRole("dialog", { name: "Stashed prompts" })).toBeTruthy();

    view.rerender(
      <ComposerPromptStash
        draft="A new prompt"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Stashed prompts" })).toBeNull());
    expect(remove).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("keeps the shortcut available when the appearance button is hidden", async () => {
    const create = vi.fn().mockResolvedValue(savedEntry);
    installBridge({ create });
    const onDraftChange = vi.fn();
    const ref = createRef<ComposerPromptStashHandle>();
    render(
      <ComposerPromptStash
        ref={ref}
        draft="Hidden button prompt"
        active
        buttonVisible={false}
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    ref.current?.activate();

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      text: "Hidden button prompt",
      provider: undefined,
      modelId: undefined,
    }));
    expect(onDraftChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("button", { name: "Stash prompt" })).toBeNull();
  });

  it("coalesces rapid shortcut presses into one durable save", async () => {
    let resolveCreate: ((entry: PromptStashEntry) => void) | undefined;
    const create = vi.fn().mockImplementation(() => new Promise<PromptStashEntry>((resolve) => {
      resolveCreate = resolve;
    }));
    installBridge({ create });
    const onDraftChange = vi.fn();
    const ref = createRef<ComposerPromptStashHandle>();
    render(
      <ComposerPromptStash
        ref={ref}
        draft="Save exactly once"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    ref.current?.activate();
    ref.current?.activate();

    expect(create).toHaveBeenCalledTimes(1);
    resolveCreate?.(savedEntry);
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(""));
  });

  it("does not clear newer text typed while a remote save is in flight", async () => {
    let resolveCreate: ((entry: PromptStashEntry) => void) | undefined;
    const create = vi.fn().mockImplementation(() => new Promise<PromptStashEntry>((resolve) => {
      resolveCreate = resolve;
    }));
    installBridge({ create });
    const onDraftChange = vi.fn();
    const ref = createRef<ComposerPromptStashHandle>();
    const view = render(
      <ComposerPromptStash
        ref={ref}
        draft="Save this version"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    ref.current?.activate();
    view.rerender(
      <ComposerPromptStash
        ref={ref}
        draft="Newer typing"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );
    resolveCreate?.(savedEntry);

    await waitFor(() => expect(view.container.querySelector(".animate-spin")).toBeNull());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ text: "Save this version" }));
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("never overwrites edits made while a restored stash is being consumed remotely", async () => {
    let resolveDelete: ((deleted: boolean) => void) | undefined;
    const remove = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveDelete = resolve;
    }));
    installBridge({
      list: vi.fn().mockResolvedValue([savedEntry]),
      delete: remove,
    });
    const onDraftChange = vi.fn();
    const view = render(
      <ComposerPromptStash
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 stashed prompt" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/i }));
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenCalledWith("Fix the parser");

    view.rerender(
      <ComposerPromptStash
        draft="Fix the parser with newer edits"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );
    resolveDelete?.(true);

    await waitFor(() => expect(view.container.querySelector(".animate-spin")).toBeNull());
    expect(remove).toHaveBeenCalledWith({ id: "stash-1" });
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });
});
