// Loads a device body: one fetch and parse per model per process, then a
// private copy per instance. Three.js is passed in so this module never pulls
// it into a flat-only bundle.
import type * as ThreeModule from "three";
import type { Group, Mesh } from "three";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AppleDeviceModelSource } from "./appleDeviceModels";

type ThreeNS = typeof ThreeModule;
type GltfLoaderCtor = typeof GLTFLoader;

/**
 * A GLTFLoader whose embedded textures load through an `<img>`, not `fetch()`.
 *
 * In Chromium, GLTFLoader decodes a `.glb`'s embedded images with
 * `ImageBitmapLoader`, which reads each image's `blob:` URL with `fetch()`.
 * The renderer CSP keeps `blob:` out of `connect-src` on purpose, so every one
 * of the 17 WebP textures failed ("Couldn't load texture blob:…") and the body
 * rendered with bare materials. `img-src` already allows `blob:`, and
 * `TextureLoader` goes through an `<img>`, so the textures load without
 * widening the policy.
 */
export function createDeviceModelLoader(THREE: Pick<ThreeNS, "TextureLoader">, GLTFLoader: GltfLoaderCtor) {
  const loader = new GLTFLoader();
  loader.register((parser) => {
    parser.textureLoader = new THREE.TextureLoader(parser.options.manager);
    return { name: "ADE_textures_through_img" };
  });
  return loader;
}

/**
 * The PARSED scene per model, which is the expensive half (a 2.4 MB fetch, a
 * 427-accessor parse and 17 WebP decodes per mount before this existed).
 *
 * Each instance gets clones of its geometries and materials, because
 * `disposeImportedSubtree` destroys both; that keeps the dispose path free of
 * exceptions. Textures are shared on purpose: no dispose path disposes a
 * texture, so one decode serves every instance for the life of the process.
 * Geometry is still copied (2.14 MB of the 2.34 MB model is vertex data);
 * sharing it would need a dispose exception, and a memcpy is far cheaper than
 * the parse it replaces.
 */
const parsedModelCache = new Map<string, Promise<Group>>();

/** Reset between tests; never called in the app. */
export function __testClearAppleModelCache(): void {
  parsedModelCache.clear();
}

function instanceOfCachedScene(template: Group): Group {
  const copy = template.clone(true);
  copy.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    // Own the two things dispose destroys.
    mesh.geometry = mesh.geometry.clone();
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => material.clone())
      : mesh.material.clone();
  });
  return copy;
}

/**
 * A fresh instance of the model's body. An abandoned load still finishes and
 * fills the cache, so the mount that superseded it pays nothing.
 */
export async function loadAppleDeviceModelInstance(
  source: AppleDeviceModelSource,
  THREE: Pick<ThreeNS, "TextureLoader">,
  GLTFLoader: GltfLoaderCtor,
): Promise<Group> {
  let template = parsedModelCache.get(source.id);
  if (!template) {
    template = (async () => {
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`model ${response.status}`);
      const gltf = await createDeviceModelLoader(THREE, GLTFLoader).parseAsync(await response.arrayBuffer(), "");
      return gltf.scene;
    })();
    parsedModelCache.set(source.id, template);
    // A failed parse must not be cached, or one bad load poisons the model
    // for the life of the process.
    void template.catch(() => parsedModelCache.delete(source.id));
  }
  return instanceOfCachedScene(await template);
}
