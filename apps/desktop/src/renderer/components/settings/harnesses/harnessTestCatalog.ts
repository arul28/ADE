import type { AgentChatModelCatalog } from "../../../../shared/types";

/**
 * A catalog shaped like the host's, carrying one runtime-only Cursor model.
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
            modelCount: 1,
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
