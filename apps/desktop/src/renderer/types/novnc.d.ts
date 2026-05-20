declare module "@novnc/novnc" {
  type RfbCredentials = {
    password?: string;
    username?: string;
    target?: string;
  };

  type RfbOptions = {
    shared?: boolean;
    credentials?: RfbCredentials;
  };

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    disconnect(): void;
    sendCredentials(credentials: RfbCredentials): void;
  }
}
