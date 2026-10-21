// ADE: three ships these USD modules without TypeScript declarations. Only
// what the vendored parser uses is declared.
declare module "three/examples/jsm/loaders/usd/USDCParser.js" {
  export type USDSpec = { specType: number; fields: Record<string, unknown> & { typeName?: unknown; default?: unknown } };
  export type USDLayer = { specsByPath: Record<string, USDSpec> } & Record<string, unknown>;
  export class USDCParser {
    parseData(buffer: ArrayBufferLike): USDLayer;
  }
}
declare module "three/examples/jsm/loaders/usd/USDComposer.js" {
  import type { Group } from "three";
  import type { USDLayer } from "three/examples/jsm/loaders/usd/USDCParser.js";
  export class USDComposer {
    texturePromises: Promise<unknown>[];
    compose(layer: USDLayer, assets?: Record<string, Uint8Array>): Group;
  }
}
