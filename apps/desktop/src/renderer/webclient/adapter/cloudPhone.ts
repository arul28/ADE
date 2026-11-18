import type { CloudPhoneStatusView, CloudPhoneView } from "../../../shared/cloudPhone";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";
import type { AdapterInfra } from "./types";

type CloudPhoneBridge = Window["ade"]["cloudPhone"];

/**
 * `window.ade.cloudPhone` for the web app: the account's ADE Cloud iPhone,
 * driven through the connected machine's `cloudPhone.*` commands — the same
 * `cloud_phone` action domain the desktop reaches through its runtime pin.
 *
 * There is no `cloudPhoneView` here: the offscreen page that paints the phone
 * lives in the desktop main process, so the pane shows NoMac's flat view in an
 * iframe instead. A pin this adapter cannot route is refused by the pin guard,
 * so a chat on another machine never has its phone answered by the wrong brain.
 *
 * `status` is a read. The rest are the person's own actions, so they ask the
 * host every time and never resolve an offline answer.
 */
export function createWebCloudPhoneNamespace(infra: Pick<AdapterInfra, "client" | "commands" | "state">): CloudPhoneBridge {
  const { commands } = infra;

  const read = async <T>(action: string, args: Record<string, unknown>, pin: RuntimePinArg): Promise<T> => {
    assertWebRuntimePinRoutable(`cloudPhone.${action}`, pin, infra);
    return await commands.call<T>(`cloudPhone.${action}`, args, {
      fallback: () => {
        throw new Error("Update ADE on that computer to see the ADE Cloud iPhone here.");
      },
      authoritative: true,
      retainLastRead: false,
    });
  };

  const write = async <T>(action: string, args: Record<string, unknown>, pin: RuntimePinArg): Promise<T> => {
    assertWebRuntimePinRoutable(`cloudPhone.${action}`, pin, infra);
    return await commands.call<T>(`cloudPhone.${action}`, args, { idempotent: false });
  };

  return {
    status: (pin) => read<CloudPhoneStatusView>("status", {}, pin),
    view: (args, pin) => write<CloudPhoneView>("view", { ...(args ?? {}) }, pin),
    start: (args, pin) => write<unknown>("start", { ...(args ?? {}) }, pin),
    stop: (pin) => write<{ stopped: boolean }>("stop", {}, pin),
    screenshot: (args, pin) => write<{ artifactId: string | null }>("screenshot", { ...args }, pin),
    // Recording needs the desktop's offscreen view, which a browser has no
    // main process to paint. Say so rather than leaving a calling pane stuck.
    record: async () => {
      throw new Error("Record the ADE Cloud iPhone in the ADE desktop app on that computer.");
    },
  };
}
