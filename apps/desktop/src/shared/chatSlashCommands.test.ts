import { describe, expect, it } from "vitest";
import {
  extractLeadingSlashCommand,
  isProviderSlashCommandInput,
  shouldTreatLeadingSlashInputAsChatText,
} from "./chatSlashCommands";

describe("chat slash command input classification", () => {
  it("extracts the command token without treating trailing punctuation as the command", () => {
    expect(extractLeadingSlashCommand("/automate")).toBe("/automate");
    expect(extractLeadingSlashCommand("/automate?")).toBe("/automate");
    expect(extractLeadingSlashCommand("/team-tools:frontend:deploy prod")).toBe("/team-tools:frontend:deploy");
    expect(extractLeadingSlashCommand("  /finalize now")).toBe("/finalize");
    expect(extractLeadingSlashCommand("please run /automate")).toBeNull();
  });

  it("keeps exact slash commands and argument-style slash commands on the provider command path", () => {
    expect(isProviderSlashCommandInput("/automate")).toBe(true);
    expect(isProviderSlashCommandInput("/automate prs, focus on merge context")).toBe(true);
    expect(shouldTreatLeadingSlashInputAsChatText("/automate")).toBe(false);
  });

  it("treats slash-prefixed natural-language questions as chat text", () => {
    expect(shouldTreatLeadingSlashInputAsChatText("/automate is a slash command in the .claude folder right?")).toBe(true);
    expect(shouldTreatLeadingSlashInputAsChatText("/automate?")).toBe(true);
    expect(shouldTreatLeadingSlashInputAsChatText("/review should show the changed files, right?")).toBe(true);
    expect(isProviderSlashCommandInput("/automate is a slash command in the .claude folder right?")).toBe(false);
  });
});
