/**
 * Behaviour-level tests for the composer. These assert what the component
 * *dispatches*, never how it renders — no snapshots.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "../src/composer/Composer";
import {
  blockedHint,
  resolveComposerAction,
  resolveComposerState,
  resolveKeyIntent,
  type ComposerStateInput,
} from "../src/composer/composerState";

function setup(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn().mockResolvedValue(undefined);
  const onSteer = vi.fn().mockResolvedValue(undefined);
  const onInterrupt = vi.fn().mockResolvedValue(undefined);
  render(
    <Composer onSend={onSend} onSteer={onSteer} onInterrupt={onInterrupt} {...props} />,
  );
  const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
  return { onSend, onSteer, onInterrupt, input };
}

describe("Composer", () => {
  it("sends on Enter when idle", async () => {
    const { onSend, onSteer, input } = setup();
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({ text: "hello" });
    expect(onSteer).not.toHaveBeenCalled();
  });

  it("steers instead of sending while a turn is running", async () => {
    const { onSend, onSteer, input } = setup({ status: "running" });
    fireEvent.change(input, { target: { value: "actually, stop" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSteer).toHaveBeenCalledWith({ text: "actually, stop" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("falls back to send when no steer handler is supplied", () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} status="running" />);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // With steering unavailable the submit is blocked, not silently re-routed
    // into a second turn.
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText(/Stop the current response/)).toBeTruthy();
  });

  it("inserts a newline on Shift+Enter rather than submitting", () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: "line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not submit mid-IME-composition", () => {
    const { onSend, input } = setup();
    fireEvent.change(input, { target: { value: "にほんご" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears the draft after a successful send", async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
    expect(input.value).toBe("");
  });

  it("restores the draft when the send throws", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("offline"));
    render(<Composer onSend={onSend} />);
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("offline")).toBeTruthy();
    expect(input.value).toBe("hello");
  });

  it("interrupts on Escape while running", () => {
    const { onInterrupt, input } = setup({ status: "running" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onInterrupt).toHaveBeenCalled();
  });

  it("does not claim Escape when nothing is running", () => {
    const { onInterrupt, input } = setup();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("shows Stop only while running", () => {
    const { input } = setup();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.change(input, { target: { value: "x" } });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("submits attachments alongside the text", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <Composer
        onSend={onSend}
        onRequestAttachment={() => [{ id: "a1", name: "invoice.pdf" }]}
      />,
    );
    fireEvent.click(screen.getByLabelText("Add attachment"));
    const input = await screen.findByLabelText("Message");
    fireEvent.change(input, { target: { value: "look" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({
      text: "look",
      attachments: [{ id: "a1", name: "invoice.pdf" }],
    });
  });

  it("allows an attachment-only submit", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <Composer onSend={onSend} onRequestAttachment={() => [{ id: "a1", name: "x.png" }]} />,
    );
    fireEvent.click(screen.getByLabelText("Add attachment"));
    const button = await screen.findByRole("button", { name: "Send" });
    fireEvent.click(button);
    expect(onSend).toHaveBeenCalledWith({ text: "", attachments: [{ id: "a1", name: "x.png" }] });
  });

  it("blocks submission until the thread is ready", () => {
    const { onSend, input } = setup({ ready: false });
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText("Connecting…")).toBeTruthy();
  });
});

// Pure state-machine tests for composerState, the helper used only by Composer.
// Folded in from composerState.test.ts (one test file per subsystem).
function input(overrides: Partial<ComposerStateInput> = {}): ComposerStateInput {
  return { draft: "hello", status: "idle", ready: true, ...overrides };
}

describe("resolveComposerAction", () => {
  it("sends when idle with a draft", () => {
    expect(resolveComposerAction(input())).toEqual({ kind: "send", text: "hello" });
  });

  it("steers rather than queueing a second turn while running", () => {
    expect(resolveComposerAction(input({ status: "running" }))).toEqual({
      kind: "steer",
      text: "hello",
    });
  });

  it("blocks a mid-turn submit when the host opted out of steering", () => {
    expect(resolveComposerAction(input({ status: "running", allowSteer: false }))).toEqual({
      kind: "blocked",
      reason: "steer_unsupported",
    });
  });

  it("trims the draft and blocks whitespace-only submits", () => {
    expect(resolveComposerAction(input({ draft: "  hi  " }))).toEqual({ kind: "send", text: "hi" });
    expect(resolveComposerAction(input({ draft: "   " }))).toEqual({
      kind: "blocked",
      reason: "empty",
    });
  });

  it("allows an attachment-only submit", () => {
    expect(resolveComposerAction(input({ draft: "", hasAttachments: true }))).toEqual({
      kind: "send",
      text: "",
    });
  });

  it("blocks before the thread resolves", () => {
    expect(resolveComposerAction(input({ ready: false }))).toEqual({
      kind: "blocked",
      reason: "no_thread",
    });
  });

  it("puts an explicit disable ahead of every other check", () => {
    expect(resolveComposerAction(input({ disabled: true, ready: false, draft: "" }))).toEqual({
      kind: "blocked",
      reason: "disabled",
    });
  });

  it("treats an errored thread as idle, so the user can retry", () => {
    expect(resolveComposerAction(input({ status: "error" }))).toEqual({
      kind: "send",
      text: "hello",
    });
  });
});

describe("resolveComposerState", () => {
  it("labels the primary button for the action it will take", () => {
    expect(resolveComposerState(input()).submitLabel).toBe("Send");
    expect(resolveComposerState(input({ status: "running" })).submitLabel).toBe("Steer");
  });

  it("offers interrupt only while running", () => {
    expect(resolveComposerState(input()).canInterrupt).toBe(false);
    expect(resolveComposerState(input({ status: "running" })).canInterrupt).toBe(true);
  });

  it("offers interrupt even with an empty draft", () => {
    const state = resolveComposerState(input({ draft: "", status: "running" }));
    expect(state.canSubmit).toBe(false);
    expect(state.canInterrupt).toBe(true);
  });

  it("does not offer interrupt when disabled or unready", () => {
    expect(resolveComposerState(input({ status: "running", disabled: true })).canInterrupt).toBe(false);
    expect(resolveComposerState(input({ status: "running", ready: false })).canInterrupt).toBe(false);
  });
});

describe("blockedHint", () => {
  it("explains only the blocks a user can act on", () => {
    expect(blockedHint("empty")).toBeNull();
    expect(blockedHint("disabled")).toBeNull();
    expect(blockedHint("no_thread")).toBe("Connecting…");
    expect(blockedHint("steer_unsupported")).toContain("Stop the current response");
  });
});

describe("resolveKeyIntent", () => {
  function keys(overrides: Partial<Parameters<typeof resolveKeyIntent>[0]> = {}) {
    return resolveKeyIntent({
      key: "Enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      isComposing: false,
      sendOnEnter: true,
      running: false,
      hasDraft: true,
      ...overrides,
    });
  }

  it("submits on Enter and inserts a newline on Shift+Enter", () => {
    expect(keys()).toBe("submit");
    expect(keys({ shiftKey: true })).toBe("newline");
  });

  it("never submits mid-IME-composition", () => {
    expect(keys({ isComposing: true })).toBe("none");
  });

  it("inverts to Cmd/Ctrl+Enter when sendOnEnter is off", () => {
    expect(keys({ sendOnEnter: false })).toBe("newline");
    expect(keys({ sendOnEnter: false, metaKey: true })).toBe("submit");
    expect(keys({ sendOnEnter: false, ctrlKey: true })).toBe("submit");
  });

  it("treats Cmd+Enter as a newline when Enter already sends", () => {
    expect(keys({ metaKey: true })).toBe("newline");
  });

  it("claims Escape only while a turn is running", () => {
    expect(keys({ key: "Escape", running: true })).toBe("interrupt");
    expect(keys({ key: "Escape", running: false })).toBe("none");
  });

  it("ignores unrelated keys", () => {
    expect(keys({ key: "a" })).toBe("none");
  });
});
