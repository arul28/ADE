# CTO Onboarding

The first-run flow for a project. Intentionally short: the CTO is usable before Linear is connected, before workers are hired, and before OpenClaw is paired. The wizard exists to pick a personality overlay — everything else is deferred.

## Source file map

### Renderer (apps/desktop/src/renderer/components/cto/)

- `OnboardingBanner.tsx` — non-modal banner rendered at the top of the CTO page while `onboardingState` is incomplete. Two buttons: "Continue" (opens wizard) and dismiss.
- `OnboardingWizard.tsx` — the single-step wizard. Personality preset grid plus optional custom-overlay textarea. Auto-rotating hints in a side chip.
- `IdentityEditor.tsx` — the editor shown in CTO Settings after onboarding is complete. Same personality model plus a model selector (provider + model + reasoning effort).
- `CtoPromptPreview.tsx` — three-section preview (doctrine, personality, memory model) used inside onboarding and settings.

### Services

- `apps/desktop/src/main/services/cto/ctoStateService.ts` — owns onboarding state. Exposes `getOnboardingState`, `updateOnboardingState`, `resetOnboarding`. Required step constant: `CTO_REQUIRED_ONBOARDING_STEPS = ["identity"]`. The service decides whether onboarding is complete, not the renderer.

### Shared

- `apps/desktop/src/shared/ctoPersonalityPresets.ts` — `CTO_PERSONALITY_PRESETS` (6 entries). The single source of truth for personality labels, descriptions, and runtime overlays.

## Onboarding state

`CtoOnboardingState` (from `shared/types`):

- `completedSteps` — string list of the steps the operator has finished.
- `dismissedAt` — ISO timestamp when the operator dismissed the banner (without completing).
- `lastTouchedAt` — ISO timestamp of the most recent change.
- `version` — onboarding schema version.

`CtoPage.tsx` reads `onboardingState` on mount and sets `showOnboarding = true` when required steps are incomplete and the banner was not recently dismissed. Reopening the wizard post-completion is done via "Reset Onboarding" in Settings.

## Banner

`OnboardingBanner.tsx` is a thin non-modal prompt: one-line title ("CTO setup is still in progress"), one-line body, a Continue button, and a dismiss X. It sits above the tab body. On dismiss it writes `dismissedAt` so it does not reappear until the next session or until setup actually completes.

## Wizard

`OnboardingWizard.tsx` flow:

1. On mount, calls `window.ade.cto.getState({ recentLimit: 0 })` to read the current identity. If an identity exists, it pre-fills the draft so the wizard acts as an edit rather than a fresh-start.
2. Renders the personality preset grid. Each preset has a themed icon and accent color:
   - `strategic` -> Strategy icon, blue.
   - `professional` -> Briefcase icon, purple.
   - `hands_on` -> Wrench icon, green.
   - `casual` -> Handshake icon, amber.
   - `minimal` -> Lightning icon, cyan.
   - `custom` -> Sparkle icon, pink.
3. If `custom` is selected, a textarea appears for `customPersonality`. Validation: custom must have non-empty text; otherwise save fails with "Add custom personality guidance or choose one of the built-in presets."
4. Side hint chip cycles through:
   - "Memory layers active"
   - "Context discovered automatically"
   - "Recovery across compaction"
   - "Doctrine stays immutable"
   — every 2.5 seconds.
5. On "Finish" the wizard calls `window.ade.cto.updateIdentity({ patch: { name: "CTO", personality, customPersonality, persona } })` where `persona` is either the custom text or the preset-derived sentence `"Persistent project CTO with <label> personality."`.
6. On success, the wizard calls `onComplete()` which the container wires to `updateOnboardingState({ completedSteps: [...existing, "identity"] })`.

There is no separate step for model selection, Linear connection, worker hiring, or OpenClaw pairing. Those happen lazily from Settings and the relevant tabs.

## Identity editor (post-onboarding)

`IdentityEditor.tsx` extends the wizard's model by adding:

- **Model selector** — `ProviderModelSelector` allows picking any configured model. Defaults to the first configured model or falls back to the existing model id.
- **Reasoning effort** — pulled from `getModelById(modelId)?.reasoningTiers`; picks the currently configured effort when valid, otherwise `medium` or the first available tier.

`applyModelSelection(draft, modelId)` centralizes the model change so provider + model short id + reasoning effort stay in sync. `coerceConfiguredModel` falls back to the first configured model if the previously saved one is no longer available.

The editor reuses the personality preset grid from the wizard. Nothing outside the personality + custom overlay + model selection can be edited — the doctrine and memory model are immutable and the capability manifest is maintained in code.

## Prompt preview

`CtoPromptPreview.tsx` renders the three-section system prompt exactly as the runtime assembles it:

1. Doctrine — immutable ADE-owned CTO mission statement.
2. Personality overlay — the selected preset's `systemOverlay` text, or the custom text.
3. Memory + environment model — the operating rules for continuity and the intent-to-tool routing map.

This is the same snapshot returned by `ctoStateService.buildSystemPromptPreview()`. Keeping the preview in code next to the runtime guarantees the UI never drifts from what the CTO actually sees.

## Completion contract

Onboarding is considered complete when every step in `CTO_REQUIRED_ONBOARDING_STEPS` is in `completedSteps`. Currently that is just `["identity"]`. Additional required steps must be added to the constant in `ctoStateService.ts` and implemented in the wizard — there is no magic auto-detection.

Dismissal does not count as completion. The banner is hidden but the state still reports incomplete until the wizard finishes. Settings > "Reset Onboarding" wipes `completedSteps` and `dismissedAt`.

## Gotchas

- **"Custom" personality requires text.** The wizard blocks save if custom is selected without content.
- **Banner dismissal is session-adjacent.** The banner reappears on next mount if required steps are still missing — dismissal does not persist across reconnections or project reloads.
- **`persona` is a UI display sentence, not a prompt input.** The runtime reads `personality` and (for custom) `customPersonality`. `persona` only shows up in the sidebar.
- **Post-onboarding edits don't re-run the wizard.** `IdentityEditor` is the only path once `completedSteps` contains `"identity"`. To re-run the wizard, use the "Reset Onboarding" button in CTO Settings.
- **Model selection can be deferred.** Onboarding does not require a model choice. If the identity has no model, the CTO chat surface uses the project's default model until the user picks one explicitly.

## Cross-links

- `README.md` — CTO shell and tab model.
- `identity-and-memory.md` — the four-layer prompt model the presets feed into.
- `pipeline-builder.md` — Linear connection is the natural next step after onboarding; the pipeline builder lives in the Workflows tab.
