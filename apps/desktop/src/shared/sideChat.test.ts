import { describe, expect, it } from "vitest";
import { extractSideChatSendToMain, parseSideSlashCommand } from "./sideChat";

describe("side chat send-to-main", () => {
  // What leaves a side chat reaches the main chat as if the user wrote it, so
  // only a block that ends the reply and sits outside code may be delivered.
  it.each([
    ["a reply with no block", "Redis was picked for the queue.", []],
    ["a block that ends the reply", "Sure.\n\n<send_to_main>Fix the typo in a.ts</send_to_main>\n", ["Fix the typo in a.ts"]],
    ["two blocks that end the reply", "Ok.\n<send_to_main>A</send_to_main>\n<send_to_main>B</send_to_main>", ["A", "B"]],
    ["a block inside inline code", "Use `<send_to_main>x</send_to_main>` to send.", []],
    ["a block inside a fenced example", "Example:\n```\n<send_to_main>x</send_to_main>\n```\nThat's it.", []],
    ["a block inside a fence the reply never closed", "Like this:\n```\n<send_to_main>x</send_to_main>", []],
    ["a block followed by more prose", "<send_to_main>early</send_to_main>\nthen more text", []],
    ["a block still streaming", "Sending now.\n<send_to_main>partial te", []],
    ["a real block after a fenced example", "```\n<send_to_main>no</send_to_main>\n```\n<send_to_main>yes</send_to_main>", ["yes"]],
    ["an empty block", "Done.\n<send_to_main>   </send_to_main>", []],
  ])("delivers %s as expected", (_name, reply, delivered) => {
    expect(extractSideChatSendToMain(reply)).toEqual(delivered);
  });

  it.each([
    ["/side why Redis?", "why Redis?"],
    ["  /SIDE  multi\nline  ", "multi\nline"],
    ["/side", ""],
    ["/sidebar please", null],
    ["ask /side later", null],
  ])("reads %j as the /side command", (text, prompt) => {
    expect(parseSideSlashCommand(text)?.prompt ?? null).toBe(prompt);
  });
});
