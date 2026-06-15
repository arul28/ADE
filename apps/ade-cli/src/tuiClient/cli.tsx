#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import React from "react";
import { render } from "ink";

type CliOptions = {
  help: boolean;
  printState: boolean;
  forceEmbedded: boolean;
  requireSocket: boolean;
  remote: boolean;
  projectRoot: string | null;
  workspaceRoot: string | null;
  laneHint: string | null;
  sessionHint: string | null;
  socketPath: string | null;
  preferServiceRepair: boolean;
};

function readRequiredFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    printState: false,
    forceEmbedded: false,
    requireSocket: false,
    remote: false,
    projectRoot: null,
    workspaceRoot: null,
    laneHint: null,
    sessionHint: null,
    socketPath: null,
    preferServiceRepair: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--print-state") options.printState = true;
    else if (arg === "--embedded") options.forceEmbedded = true;
    else if (arg === "--require-socket") options.requireSocket = true;
    else if (arg === "--remote") options.remote = true;
    else if (arg === "--prefer-service-repair") options.preferServiceRepair = true;
    else if (arg === "--project-root") {
      options.projectRoot = readRequiredFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === "--workspace-root") {
      options.workspaceRoot = readRequiredFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === "--lane") {
      options.laneHint = readRequiredFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === "--session" || arg === "--chat") {
      options.sessionHint = readRequiredFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === "--socket") {
      options.socketPath = readRequiredFlagValue(argv, i, arg);
      i += 1;
    } else {
      throw new Error(`Unknown ade code option: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  process.stdout.write(`ade code

Terminal-native ADE Work chat.

Usage:
  ade code [--project-root <path>] [--workspace-root <path>] [--lane <id|name|branch>] [--socket <path>]
  ade code remote [project|session]
  ade code --embedded
  ade code --require-socket
  ade code --print-state

Keys:
  ctrl-o   open or focus lanes and chats
  ctrl-p   open or focus details
  ctrl-g   split chat: add another chat tile
  ctrl-w   split chat: close focused tile
  ctrl-t   toggle Claude terminal control when a Claude Code terminal is active
  tab      split chat: cycle focused tile
  shift-tab cycle pane focus
  esc      return or cancel the active pane
  ?        help when it is the first and only prompt character
  /        command palette
`);
}

function writeStdout(value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function suppressTerminalWarnings(): void {
  if (process.env.ADE_CODE_SHOW_WARNINGS === "1") return;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function emitAdeCodeWarning(warning: string | Error, ...args: unknown[]): void {
    const message = warning instanceof Error ? warning.message : String(warning);
    const type = typeof args[0] === "string" ? args[0] : "";
    if (type === "ExperimentalWarning" && message.includes("SQLite is an experimental feature")) {
      return;
    }
    (originalEmitWarning as (...innerArgs: unknown[]) => void).call(process, warning, ...args);
  } as typeof process.emitWarning;
}

async function printState(options: CliOptions): Promise<void> {
  suppressTerminalWarnings();
  const { listChatSessions, listLanes } = await import("./adeApi");
  const { connectToAde } = await import("./connection");
  const { detectProjectLaunchContext } = await import("./project");
  const project = detectProjectLaunchContext({
    projectRoot: options.projectRoot,
    workspaceRoot: options.workspaceRoot,
    laneHint: options.laneHint,
    sessionHint: options.sessionHint,
    remote: options.remote,
  });
  const connection = await connectToAde({
    project,
    forceEmbedded: options.forceEmbedded,
    requireSocket: options.requireSocket,
    socketPath: options.socketPath,
    preferServiceRepair: options.preferServiceRepair,
    remote: options.remote,
  });
  try {
    const lanes = await listLanes(connection);
    const sessions = await listChatSessions(connection);
    await writeStdout(`${JSON.stringify({
      mode: connection.mode,
      projectRoot: project.projectRoot,
      workspaceRoot: project.workspaceRoot,
      laneCount: lanes.length,
      chatCount: sessions.length,
      socketPath: connection.socketPath,
    }, null, 2)}\n`);
  } finally {
    await connection.close();
  }
}

export async function runAdeCodeCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.printState) {
    await printState(options);
    return 0;
  }
  suppressTerminalWarnings();
  const { AdeCodeApp } = await import("./app");
  const { detectProjectLaunchContext } = await import("./project");
  const project = detectProjectLaunchContext({
    projectRoot: options.projectRoot,
    workspaceRoot: options.workspaceRoot,
    laneHint: options.laneHint,
    sessionHint: options.sessionHint,
    remote: options.remote,
  });
  const instance = render(
    <AdeCodeApp
      project={project}
      forceEmbedded={options.forceEmbedded}
      requireSocket={options.requireSocket}
      socketPath={options.socketPath}
      preferServiceRepair={options.preferServiceRepair}
      remote={options.remote}
    />,
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  return 0;
}

const isDirectEntry = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectEntry) {
  void runAdeCodeCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ade code: ${message}\n`);
    process.exitCode = 1;
  });
}
