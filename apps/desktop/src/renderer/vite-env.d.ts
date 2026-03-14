/// <reference types="vite/client" />

declare module "*?worker" {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}

