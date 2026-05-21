import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const settingsTour: Tour = {
  id: "settings",
  title: "Settings walkthrough",
  route: "/settings",
  steps: [
    {
      target: '[data-tour="settings.appearance"]',
      title: "How ADE looks",
      body: "Pick a theme (light, dark, high-contrast), tweak how dense the layout is, change the accent color. Cosmetic only — nothing here breaks anything.",
      docUrl: docs.settingsGeneral,
      placement: "right",
    },
    {
      target: '[data-tour="settings.ai"]',
      title: "Which AI to use",
      body: "ADE works with several AI services — Claude, OpenAI's GPT, local models you run yourself, or your own custom endpoint. Plug in your account here, and your AI helpers (workers) will use them.",
      docUrl: docs.settingsGeneral,
      placement: "right",
    },
    {
      target: '[data-tour="settings.laneTemplates"]',
      title: "Reusable lane recipes",
      body: "Save a lane setup as a **template** — its tools, scripts, runtime — so the next time you make a lane, you can apply the recipe in one click instead of setting it up again.",
      docUrl: docs.settingsGeneral,
      placement: "right",
    },
  ],
};

registerTour(settingsTour);

export default settingsTour;
