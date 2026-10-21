import { describe, expect, it } from "vitest";
import { parseCodedErrorMessage } from "../../../../desktop/src/shared/codedError";
import { createMachineConnectionPool } from "./machineBridge";

describe("machine connection action responses", () => {
  it("preserves a definitive destination refusal code", () => {
    const bridge = createMachineConnectionPool({
      poolId: "machine-bridge-return-refusal-test",
      pairedStoreFile: "unused-test-store.json",
      deviceName: () => "ADE agents test",
      initializeParams: () => ({}),
      appVersion: "test",
      projectRoots: () => [],
      who: "agents",
      requestNoun: "chat actions",
      logPrefix: "machine_bridge_test",
    });
    let refusal: unknown;
    try {
      bridge.checkActionResponse("Mac mini", "chat.acceptCrossMachineHandoff", {
        ok: false,
        error: {
          code: "cross_machine_return_refused",
          message: "The original chat stays as it is.",
        },
      }, "machine-b");
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({ code: "cross_machine_return_refused" });
    expect(parseCodedErrorMessage(refusal)).toEqual({
      code: "cross_machine_return_refused",
      message: "Mac mini refused chat.acceptCrossMachineHandoff: The original chat stays as it is.",
    });
  });
});
