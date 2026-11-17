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
 * nothing on the way to the first window uses them. Each loader below
 * requires its package the first time it is called; Node's module cache makes
 * every later call free. The brain bundle (apps/ade-cli) is CommonJS too, so
 * `require` resolves the same package there.
 */

let yamlModule: typeof YamlModule | null = null;
let nodeCronModule: typeof NodeCronModule | null = null;
let mp4MuxerModule: typeof Mp4MuxerModule | null = null;

function loadYaml(): typeof YamlModule {
  yamlModule ??= require("yaml") as typeof YamlModule;
  return yamlModule;
}

/** node-cron, loaded on first use. */
export function loadNodeCron(): typeof NodeCronModule {
  nodeCronModule ??= require("node-cron") as typeof NodeCronModule;
  return nodeCronModule;
}

/** mp4-muxer, loaded on first use. */
export function loadMp4Muxer(): typeof Mp4MuxerModule {
  mp4MuxerModule ??= require("mp4-muxer") as typeof Mp4MuxerModule;
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
