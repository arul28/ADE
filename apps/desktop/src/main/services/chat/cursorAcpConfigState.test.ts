import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { readCursorAcpConfigSnapshot } from "./cursorAcpConfigState";

describe("readCursorAcpConfigSnapshot", () => {
  it("extracts model and mode selectors when ACP categorizes them", () => {
    const configOptions: SessionConfigOption[] = [
      {
        id: "session-model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "composer-2",
        options: [
          { value: "auto", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
        ],
      },
      {
        id: "session-mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "ask",
        options: [
          { value: "ask", name: "Ask" },
          { value: "plan", name: "Plan" },
        ],
      },
    ];

    expect(readCursorAcpConfigSnapshot(configOptions)).toEqual({
      modeConfigId: "session-mode",
      currentModeId: "ask",
      availableModeIds: ["ask", "plan"],
      modelConfigId: "session-model",
      currentModelId: "composer-2",
      availableModelIds: ["auto", "composer-2"],
      configOptions: [
        {
          id: "session-model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "composer-2",
          options: [
            { value: "auto", label: "Auto", description: null, groupId: null, groupLabel: null },
            { value: "composer-2", label: "Composer 2", description: null, groupId: null, groupLabel: null },
          ],
        },
        {
          id: "session-mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "ask",
          options: [
            { value: "ask", label: "Ask", description: null, groupId: null, groupLabel: null },
            { value: "plan", label: "Plan", description: null, groupId: null, groupLabel: null },
          ],
        },
      ],
    });
  });

  it("falls back to option names and handles grouped model options", () => {
    const configOptions: SessionConfigOption[] = [
      {
        id: "model-selector",
        name: "Session model",
        type: "select",
        currentValue: "gpt-5.4",
        options: [
          {
            group: "openai",
            name: "OpenAI",
            options: [
              { value: "gpt-5.4", name: "GPT-5.4" },
            ],
          },
          {
            group: "anthropic",
            name: "Anthropic",
            options: [
              { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
            ],
          },
        ],
      },
    ];

    expect(readCursorAcpConfigSnapshot(configOptions)).toEqual({
      modeConfigId: null,
      currentModeId: null,
      availableModeIds: [],
      modelConfigId: "model-selector",
      currentModelId: "gpt-5.4",
      availableModelIds: ["gpt-5.4", "claude-sonnet-4.6"],
      configOptions: [
        {
          id: "model-selector",
          name: "Session model",
          type: "select",
          currentValue: "gpt-5.4",
          options: [
            { value: "gpt-5.4", label: "GPT-5.4", description: null, groupId: "openai", groupLabel: "OpenAI" },
            { value: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", description: null, groupId: "anthropic", groupLabel: "Anthropic" },
          ],
        },
      ],
    });
  });

  it("ignores invalid current values that do not match any selectable option", () => {
    const configOptions: SessionConfigOption[] = [
      {
        id: "session-model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "default[]",
        options: [
          { value: "auto", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
        ],
      },
      {
        id: "session-mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "default[]",
        options: [
          { value: "edit", name: "Edit" },
          { value: "plan", name: "Plan" },
        ],
      },
    ];

    expect(readCursorAcpConfigSnapshot(configOptions)).toEqual({
      modeConfigId: "session-mode",
      currentModeId: null,
      availableModeIds: ["edit", "plan"],
      modelConfigId: "session-model",
      currentModelId: null,
      availableModelIds: ["auto", "composer-2"],
      configOptions: [
        {
          id: "session-model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: null,
          options: [
            { value: "auto", label: "Auto", description: null, groupId: null, groupLabel: null },
            { value: "composer-2", label: "Composer 2", description: null, groupId: null, groupLabel: null },
          ],
        },
        {
          id: "session-mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: null,
          options: [
            { value: "edit", label: "Edit", description: null, groupId: null, groupLabel: null },
            { value: "plan", label: "Plan", description: null, groupId: null, groupLabel: null },
          ],
        },
      ],
    });
  });
});
