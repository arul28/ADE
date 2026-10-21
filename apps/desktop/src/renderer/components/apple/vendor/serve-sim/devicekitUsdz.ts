import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";
import { USDCParser, type USDLayer } from "three/examples/jsm/loaders/usd/USDCParser.js";
import { USDComposer } from "three/examples/jsm/loaders/usd/USDComposer.js";

/** Compose V68's geometry payload and its wrapper's selected color variant.
 * Three's USDLoader does not yet compose binary PayloadListOp layers. Keep the
 * original archive intact and use its USD parser/material loader at runtime.
 */
export async function parseDeviceKitUsdz(bytes: ArrayBuffer) {
  const assets = unzipSync(new Uint8Array(bytes));
  const layers = Object.entries(assets)
    .filter(([name]) => /\.usd[ac]?$/.test(name))
    .map(([name, data]) => {
      const layer = new USDCParser().parseData(data.slice().buffer);
      const directory = name.slice(0, name.lastIndexOf("/") + 1);
      // Asset paths are relative to their own layer, including color overrides.
      for (const spec of Object.values(layer.specsByPath)) {
        if (spec.fields.typeName === "asset" && typeof spec.fields.default === "string") {
          const path = directory + spec.fields.default.replace(/^\.\//, "");
          if (!assets[path]) throw new Error("Missing texture in Xcode's Duo model");
          spec.fields.default = path;
        }
      }
      return layer;
    });
  const payloads = layers.filter((layer) =>
    Object.values(layer.specsByPath).some((spec) => spec.fields.typeName === "Mesh"),
  );
  if (payloads.length !== 1) throw new Error("Unsupported Xcode Duo model layout");
  const composed = payloads[0]!;
  for (const layer of layers) {
    if (layer === composed) continue;
    applySelectedLayer(composed, layer);
  }
  const composer = new USDComposer();
  const model = composer.compose(composed, assets);
  await Promise.all(composer.texturePromises);
  return model;
}

export function applySelectedLayer(target: USDLayer, layer: USDLayer): void {
  for (const [path, spec] of Object.entries(layer.specsByPath)) {
    // Variant set/variant specs are containers, not scene objects.
    if (spec.specType === 10 || spec.specType === 11) continue;
    let selected = true;
    const plainPath = path.replace(
      /\/\{([^=]+)=([^}]+)\}/g,
      (_match, set: string, value: string, offset: number) => {
        const owner = layer.specsByPath[path.slice(0, offset)];
        const selection = owner?.fields.variantSelection as Record<string, string> | undefined;
        if (selection?.[set] !== value) selected = false;
        return "";
      },
    );
    if (!selected) continue;
    const previous = target.specsByPath[plainPath];
    const fields = { ...previous?.fields, ...spec.fields };
    for (const key of ["primChildren", "properties"]) {
      if (Array.isArray(previous?.fields[key]) && Array.isArray(spec.fields[key])) {
        fields[key] = [...new Set([...previous.fields[key], ...spec.fields[key]])];
      }
    }
    delete fields.payload;
    delete fields.variantSetChildren;
    delete fields.variantSetNames;
    delete fields.variantSelection;
    target.specsByPath[plainPath] = { specType: previous?.specType ?? spec.specType, fields };
  }
}
