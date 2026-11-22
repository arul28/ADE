import { createRequire } from "node:module";
import type * as Mp4MuxerModule from "mp4-muxer";
import type * as NodeCronModule from "node-cron";
import type * as YamlModule from "yaml";

/*
 * Packages the main process loads on first use, not at launch.
 *
 * The main bundle keeps its npm dependencies external, and esbuild runs every
 * static import of one when the bundle loads. So `import YAML from "yaml"` in
 * any module of the main graph read and compiled the package (yaml: 72 files,
 * node-cron: 29, mp4-muxer: 1) from app.asar before the first window, though
 * nothing on the way to the first window uses them. Each loader below loads
 * its package the first time it is called; Node's module cache makes every
 * later call free.
 *
 * Two runtimes reach this module: the CommonJS bundles (the desktop main
 * process and the brain, where `require` is there) and TypeScript run
 * directly as ES modules (the CLI's `tsx` dev script, and tests). An ES module
 * has no `require` binding, so the loaders go through a `require` anchored to
 * this file in that case — the same package the bundle would resolve.
 */
const loadPackage: NodeRequire = (() => {
  if (typeof require === "function") return require;
  try {
    return createRequire(import.meta.url);
  } catch {
    // No module URL to anchor to: the caller's own resolution is the last word.
    return createRequire(`${process.cwd()}/`);
  }
})();

let yamlModule: typeof YamlModule | null = null;
let nodeCronModule: typeof NodeCronModule | null = null;
let mp4MuxerModule: typeof Mp4MuxerModule | null = null;

function loadYaml(): typeof YamlModule {
  yamlModule ??= loadPackage("yaml") as typeof YamlModule;
  return yamlModule;
}

/** node-cron, loaded on first use. */
export function loadNodeCron(): typeof NodeCronModule {
  nodeCronModule ??= loadPackage("node-cron") as typeof NodeCronModule;
  return nodeCronModule;
}

/** mp4-muxer, loaded on first use. */
export function loadMp4Muxer(): typeof Mp4MuxerModule {
  mp4MuxerModule ??= loadPackage("mp4-muxer") as typeof Mp4MuxerModule;
  return mp4MuxerModule;
}

type YamlFunctionName = "parse" | "stringify" | "parseDocument" | "isMap" | "isScalar";

/** One of yaml's functions, with its own type, that loads yaml on its first call. */
function lazyYamlFunction<K extends YamlFunctionName>(name: K): (typeof YamlModule)[K] {
  return ((...args: unknown[]) => (loadYaml()[name] as (...callArgs: unknown[]) => unknown)(...args)) as unknown as (typeof YamlModule)[K];
}

export const parseYaml = lazyYamlFunction("parse");
export const stringifyYaml = lazyYamlFunction("stringify");
export const parseYamlDocument = lazyYamlFunction("parseDocument");
export const isYamlMap = lazyYamlFunction("isMap");
export const isYamlScalar = lazyYamlFunction("isScalar");

/**
 * The part of yaml's API the main process uses, in the shape of its default
 * export (`YAML.parse`, `YAML.stringify`, `YAML.parseDocument`), loaded on the
 * first call.
 */
export const YAML = {
  parse: parseYaml,
  stringify: stringifyYaml,
  parseDocument: parseYamlDocument,
};
