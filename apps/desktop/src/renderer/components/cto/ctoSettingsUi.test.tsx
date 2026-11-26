/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutosaveTextArea, type AutosaveHostAnswer } from "./ctoSettingsUi";

afterEach(cleanup);

/** A notes field whose first save waits until the test answers it. */
function renderNotes(value: string) {
  let answer!: (kept: AutosaveHostAnswer) => void;
  const onSave = vi.fn((_text: string, _baseHash?: string): Promise<AutosaveHostAnswer | void> => (
    onSave.mock.calls.length === 1
      ? new Promise<AutosaveHostAnswer>((resolve) => { answer = resolve; })
      : Promise.resolve()
  ));
  render(<AutosaveTextArea value={value} hash="h1" onSave={onSave} overflowMovesOut limit={8} ariaLabel="Notes" />);
  const field = screen.getByLabelText("Notes") as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(field, { target: { value: text } });
  return { field, onSave, type, answer: (kept: AutosaveHostAnswer) => act(async () => answer(kept)) };
}

describe("AutosaveTextArea over its cap", () => {
  it("puts keystrokes from during a save onto what the host kept, so the lines it moved out stay out", async () => {
    const notes = renderNotes("- a\n- b\n- c");
    notes.type("- a\n- b\n- c\n- d");
    fireEvent.blur(notes.field);
    expect(notes.onSave).toHaveBeenLastCalledWith("- a\n- b\n- c\n- d", "h1");
    notes.type("- a\n- b\n- c\n- d\n- e");

    await notes.answer({ text: "- b\n- c\n- d", hash: "h2" });
    await waitFor(() => expect(notes.field.value).toBe("- b\n- c\n- d\n- e"));
    fireEvent.blur(notes.field);
    expect(notes.onSave).toHaveBeenLastCalledWith("- b\n- c\n- d\n- e", "h2");
  });

  it("stops for a conflict when the host moved out the line being edited", async () => {
    const notes = renderNotes("- a\n- b\n- c");
    notes.type("- a\n- b\n- c\n- d");
    fireEvent.blur(notes.field);
    notes.type("- a!\n- b\n- c\n- d");

    await notes.answer({ text: "- b\n- c\n- d", hash: "h2" });
    await screen.findByText("Changed elsewhere");
    fireEvent.blur(notes.field);
    expect(notes.onSave).toHaveBeenCalledTimes(1);
  });
});
