// The one panel this plugin draws, as a function of its own readiness.
//
// It is not where dictation happens — that is the Dictate button this plugin
// contributes to the composer. What the panel is for is the one question a user
// actually asks about voice ("why is nothing happening?"), answered in the four
// states that can produce it: this machine has no engine, the model has not
// been downloaded, it is downloading now, or everything is ready.
//
// Kept in a module of its own so the states are testable without a host: the
// schema is data, and data is worth asserting on.

"use strict";

const DEEPLINK = "ade://plugin/ade-voice/main";

function fallback(text) {
  return { title: "Voice", text, deeplink: DEEPLINK };
}

function schema(body, fallbackText) {
  return { v: 1, title: "Voice", fallback: fallback(fallbackText), body };
}

/** Human bytes for the one number worth showing while a download runs. */
function megabytes(bytes) {
  return `${Math.max(0, Math.round((bytes ?? 0) / (1024 * 1024)))} MB`;
}

function buildPanelSchema(status) {
  if (!status.platformSupported) {
    return schema(
      [{
        component: "emptyState",
        title: "Not available on this computer",
        description: `Voice dictation runs a speech engine on your own machine, and this version ships one for macOS only — not for ${status.platform}. Nothing was sent anywhere; there is simply nothing here to run.`,
        icon: "microphone",
      }],
      "Voice dictation ships a macOS speech engine only, so it cannot run on this computer.",
    );
  }

  if (status.downloading) {
    return schema(
      [{
        component: "stack",
        direction: "vertical",
        gap: "md",
        children: [
          { component: "text", text: "Getting voice dictation ready", variant: "title" },
          {
            component: "text",
            text: `The speech model is downloading — ${status.progress ?? megabytes(status.receivedBytes)} of about 141 MB. It downloads once and stays on this computer. Dictation works as soon as it finishes.`,
            variant: "body",
          },
          { component: "button", label: "Check again", kind: "default", onPress: { action: "refresh" } },
        ],
      }],
      "The speech model is downloading. Dictation works as soon as it finishes.",
    );
  }

  if (!status.modelInstalled) {
    return schema(
      [{
        component: "emptyState",
        title: "One download, then dictation works offline",
        description: status.lastDownloadError
          ? `The speech model could not be downloaded (${status.lastDownloadError}) Check the internet connection and try again.`
          : "Voice dictation transcribes on this computer, using a 141 MB speech model that is downloaded once. Start it now, or just press Dictate beside the composer — pressing it starts the download too.",
        icon: "microphone",
        action: { label: "Download the speech model", onPress: { action: "prepare" } },
      }],
      "Voice dictation needs a one-time 141 MB speech model. Open ADE on this computer to download it.",
    );
  }

  return schema(
    [{
      component: "stack",
      direction: "vertical",
      gap: "md",
      children: [
        { component: "text", text: "Voice dictation is ready", variant: "title" },
        {
          component: "text",
          text: "Press Dictate beside the composer and speak. Your voice is transcribed on this computer by a speech model stored here — no audio leaves the machine.",
          variant: "body",
        },
        {
          component: "keyValue",
          rows: [
            { key: "Speech model", value: "ggml-base.en (English)" },
            { key: "Stored in", value: status.modelDir },
          ],
        },
      ],
    }],
    "Voice dictation is ready on this computer. Press Dictate beside the composer and speak.",
  );
}

module.exports = { DEEPLINK, buildPanelSchema };
