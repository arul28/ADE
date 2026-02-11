export const IPC = {
  appPing: "ade.app.ping",
  appGetInfo: "ade.app.getInfo",
  appGetProject: "ade.app.getProject",
  projectOpenRepo: "ade.project.openRepo",
  projectOpenAdeFolder: "ade.project.openAdeFolder",
  lanesList: "ade.lanes.list",
  lanesCreate: "ade.lanes.create",
  lanesRename: "ade.lanes.rename",
  lanesArchive: "ade.lanes.archive",
  lanesOpenFolder: "ade.lanes.openFolder",
  sessionsList: "ade.sessions.list",
  sessionsGet: "ade.sessions.get",
  sessionsReadTranscriptTail: "ade.sessions.readTranscriptTail",
  ptyCreate: "ade.pty.create",
  ptyWrite: "ade.pty.write",
  ptyResize: "ade.pty.resize",
  ptyDispose: "ade.pty.dispose",
  ptyData: "ade.pty.data",
  ptyExit: "ade.pty.exit",
  diffGetChanges: "ade.diff.getChanges",
  diffGetFile: "ade.diff.getFile",
  filesWriteTextAtomic: "ade.files.writeTextAtomic",
  layoutGet: "ade.layout.get",
  layoutSet: "ade.layout.set"
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
