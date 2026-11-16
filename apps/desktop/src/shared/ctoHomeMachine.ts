/**
 * The account setting that names a project's CTO home machine: scope
 * `repo:<normalized origin>`, key `cto.homeMachine`. Shared by the desktop
 * (`renderer/components/cto/ctoHomeMachine.ts`) and the brain's
 * `cto.getHomeMachine` / `cto.setHomeMachine` phone commands.
 */
export const CTO_HOME_SETTING_KEY = "cto.homeMachine";

export type CtoHomeMachineRecord = {
  version: 1;
  /** Sync device id of the home machine. Null for SSH targets. */
  deviceId: string | null;
  /** The machine's own name, for display on machines that cannot reach it. */
  name: string;
  hostname: string | null;
  chosenAt: string;
  /**
   * The ADE Cloud computer the CTO lives on, when its home is one
   * (`ctoCloudHome.ts`). Lets every surface wake it, and make a new one when
   * the idle cleanup deleted it. Absent for the person's own machines.
   */
  cloudInstanceId?: string | null;
};

/** The ADE Cloud computer a home record names, or null for the person's own machine. */
export function ctoHomeCloudInstanceId(record: CtoHomeMachineRecord | null | undefined): string | null {
  const id = record?.cloudInstanceId;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

export function isCtoHomeMachineRecord(value: unknown): value is CtoHomeMachineRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && (record.deviceId === null || (typeof record.deviceId === "string" && record.deviceId.length > 0))
    && typeof record.name === "string"
    && record.name.trim().length > 0
    && (record.hostname === null || typeof record.hostname === "string")
    && typeof record.chosenAt === "string";
}
