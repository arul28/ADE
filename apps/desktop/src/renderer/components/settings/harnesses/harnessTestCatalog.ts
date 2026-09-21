import type { AgentChatModelCatalog } from "../../../../shared/types";

/**
 * A catalog shaped like the host's, carrying two runtime-only Cursor models.
 *
 * Cursor reports a union: some models are reachable through its SDK, some only
 * through its CLI. The fixture carries one of each so a surface that starts
 * chats can prove it offers the SDK-capable one and withholds the CLI-only
 * one.
 *
 * Shared by the wizard and model-choice tests so both prove their behaviour
 * against the same shape; two copies of a fixture are two things to keep in
 * step with the real catalog.
 *
 * The cast is deliberate and stays in this one place: the rows carry only the
 * fields the code under test reads, not the full `AgentChatModelCatalogModel`
 * contract (`isDefault`, `runtimeModelId`, `provider`, `providerKey`).
 */
export function cursorCatalog(): AgentChatModelCatalog {
  return {
    fetchedAt: "2026-09-21T00:00:00.000Z",
    groups: [
      {
        key: "cursor",
        displayName: "Cursor",
        providers: [
          {
            key: "cursor",
            displayName: "Cursor",
            badgeColor: "#000000",
            modelCount: 2,
            subsections: [
              {
                key: "cursor",
                label: "Cursor",
                models: [
                  {
                    id: "cursor/composer-9",
                    displayName: "Composer 9",
                    groupKey: "cursor",
                    isAvailable: true,
                    cursorAvailability: { sdk: true, cli: true },
                  },
                  {
                    id: "cursor/cli-only",
                    displayName: "CLI Only",
                    groupKey: "cursor",
                    isAvailable: true,
                    cursorAvailability: { sdk: false, cli: true },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  } as unknown as AgentChatModelCatalog;
}
