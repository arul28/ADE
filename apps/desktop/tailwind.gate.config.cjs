const base = require("./tailwind.config.cjs");

/**
 * Tailwind for the hosted client's sign-in stylesheet
 * (`src/renderer/webclient/gate.css`): the same theme as the app, scanning
 * only what renders before the workspace loads. A component the boot screens
 * or the sign-in card render must be listed here, or its utility classes
 * compile to nothing on that screen.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  ...base,
  content: [
    "./src/renderer/webclient/shell/**/*.{ts,tsx}",
    "./src/renderer/components/onboarding/**/*.{ts,tsx}",
    "./src/renderer/components/app/AppearanceRoot.tsx",
    "./src/renderer/components/app/ThemeDocumentSync.tsx",
    "./src/renderer/components/app/ReportIssueButton.tsx",
    "./src/renderer/components/app/errorSurfaceKit.tsx",
    "./src/renderer/components/settings/BrainRepairButton.tsx",
    "./src/renderer/components/terminals/WorkToolPickerBackdrop.tsx",
    "./src/renderer/components/ui/SmartTooltip.tsx",
    "./src/renderer/scene/SceneImageLayer.tsx",
  ],
};
