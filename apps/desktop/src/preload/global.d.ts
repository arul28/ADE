export {};

declare global {
  interface Window {
    ade: {
      ping: () => Promise<string>;
    };
  }
}

