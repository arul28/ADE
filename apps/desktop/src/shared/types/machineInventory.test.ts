import { describe, expect, it } from "vitest";
import {
  buildMachineInventoryDetail,
  buildMachineInventorySummary,
  type MachineInventoryProviderInput,
  type MachineInventoryPresetInput,
} from "./machineInventory";

const providerInstances: MachineInventoryProviderInput[] = [
  {
    id: "claude-work",
    provider: "claude",
    label: "Work",
    isDefault: true,
    account: { email: "ada@example.com", plan: "Pro" },
  },
  {
    id: "claude-personal",
    provider: "claude",
    label: "Personal",
    isDefault: false,
  },
  {
    id: "codex-default",
    provider: "codex",
    label: "Default",
    isDefault: true,
    account: { plan: "Plus" },
  },
];

const presets: MachineInventoryPresetInput[] = [
  { id: "ship", name: "Ship", harness: "claude", model: "sonnet" },
  { id: "review", name: "Review", harness: "codex", model: "gpt-5" },
];

describe("machine inventory builders", () => {
  it("groups provider accounts and keeps model and preset counts token-free", () => {
    expect(buildMachineInventorySummary({
      providerInstances,
      modelCounts: { claude: 4, codex: 2 },
      presets,
    })).toEqual({
      providers: [
        { provider: "claude", accounts: 2, models: 4 },
        { provider: "codex", accounts: 1, models: 2 },
      ],
      presets: 2,
    });
  });

  it("builds detail with account metadata and local preset binding state", () => {
    const detail = buildMachineInventoryDetail({
      machineKey: "machine-1",
      providerInstances,
      modelCounts: { claude: 4, codex: 2 },
      presets,
      boundPresetIds: new Set(["ship"]),
    });

    expect(detail).toEqual({
      machineKey: "machine-1",
      providers: [
        {
          provider: "claude",
          modelCount: 4,
          accounts: [
            {
              instanceId: "claude-work",
              label: "Work",
              email: "ada@example.com",
              plan: "Pro",
              isDefault: true,
            },
            { instanceId: "claude-personal", label: "Personal", isDefault: false },
          ],
        },
        {
          provider: "codex",
          modelCount: 2,
          accounts: [
            { instanceId: "codex-default", label: "Default", plan: "Plus", isDefault: true },
          ],
        },
      ],
      presets: [
        { id: "ship", name: "Ship", harness: "claude", model: "sonnet", bound: true },
        { id: "review", name: "Review", harness: "codex", model: "gpt-5", bound: false },
      ],
    });
    expect(JSON.stringify(detail)).not.toMatch(/configHome|apiKey|secret|token/i);
  });

  it("drops malformed rows and clamps counts", () => {
    expect(buildMachineInventorySummary({
      providerInstances: [
        ...providerInstances,
        { id: "", provider: "claude", label: "ignored", isDefault: false },
      ],
      modelCounts: { claude: 3.8, codex: -2 },
      presets: [
        ...presets,
        { id: "", name: "ignored", harness: "claude", model: "sonnet" },
      ],
    })).toEqual({
      providers: [
        { provider: "claude", accounts: 2, models: 3 },
        { provider: "codex", accounts: 1, models: 0 },
      ],
      presets: 2,
    });
  });
});
