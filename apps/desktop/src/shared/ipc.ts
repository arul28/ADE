export const IPC = {
  appPing: "ade.app.ping",
  appGetInfo: "ade.app.getInfo",
  appGetProject: "ade.app.getProject",
  layoutGet: "ade.layout.get",
  layoutSet: "ade.layout.set"
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

