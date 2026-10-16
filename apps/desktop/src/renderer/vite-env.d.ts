/// <reference types="vite/client" />

declare module "*?worker" {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}


/** The URL of three.js as one classic script for 3D scenes; see `vite.sceneThree.ts`. */
declare module "virtual:ade-scene-three" {
  const url: string;
  export default url;
}
