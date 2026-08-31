/**
 * Full assembly against a fake client.
 *
 * Two shapes are shown: `<AdeChat>` (the composed default) and the same thing
 * built from the individual pieces, which is what a host does when it wants its
 * own layout. Both use the same `createFakeClient()` stub, so this file also
 * doubles as the demo harness.
 */

import { useState } from "react";

import {
  AdeChat,
  AdeChatProvider,
  Composer,
  ModelPicker,
  ProviderCards,
  Transcript,
  createTheme,
  useAdeThread,
  type ActivityLabelConfig,
  type ModelDescriptor,
} from "../src";
import { createFakeClient } from "./fakeClient";

const client = createFakeClient();

/**
 * The whole point of the label system: a customer never sees "server.tool".
 * A bare string is the running verb; an object gives every phase its own copy.
 */
const labels: ActivityLabelConfig = {
  map: {
    "server.tool": {
      running: "Searching your invoices…",
      done: "Searched your invoices",
      error: "Could not search your invoices",
    },
    "server.*": "Talking to your account…",
    "*": "Working…",
  },
  thinkingLabel: "Thinking…",
};

const theme = createTheme({
  accent: "#7c5cff",
  background: "#0e0f13",
  radius: 12,
});

/** The composed default — transcript plus composer with the model rail. */
export function BasicChat() {
  return (
    <div style={{ height: 600, maxWidth: 720 }}>
      <AdeChat
        client={client}
        threadKey="demo"
        defaultModelId="claude-sonnet"
        labels={labels}
        theme={theme}
        placeholder="Ask about your account…"
        onRequestAttachment={async () => [
          { id: `file-${Date.now()}`, name: "invoice.pdf", mimeType: "application/pdf" },
        ]}
      />
    </div>
  );
}

/** The same capability, assembled by the host. */
export function CustomLayout() {
  const [model, setModel] = useState<ModelDescriptor | null>(null);

  return (
    <AdeChatProvider client={client} labels={labels}>
      <div className="adechat-root" style={{ ...theme, height: 600, maxWidth: 720 }}>
        {/* Provider cards are free-floating: put them wherever they belong. */}
        <div style={{ display: "grid", gap: 8, padding: 16 }}>
          <ProviderCards client={client} />
        </div>
        <ThreadPane
          modelId={model?.id ?? "claude-sonnet"}
          rail={<ModelPicker client={client} value={model?.id ?? null} onChange={setModel} />}
        />
      </div>
    </AdeChatProvider>
  );
}

function ThreadPane({ modelId, rail }: { modelId: string; rail: React.ReactNode }) {
  const thread = useAdeThread("demo-custom", { client, modelId });

  return (
    <>
      <Transcript
        rows={thread.rows}
        status={thread.status.state}
        labels={labels}
        emptyState="Ask anything about your account."
      />
      <Composer
        onSend={thread.send}
        onSteer={thread.steer}
        onInterrupt={thread.interrupt}
        status={thread.status.state}
        ready={thread.ready}
        modelRail={rail}
      />
    </>
  );
}
