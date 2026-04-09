// Stub for lottie-react to avoid lottie-web canvas errors in jsdom tests.
// lottie-web tries to getContext("2d") on a <canvas> element which is not
// implemented in jsdom without the canvas npm package.

import { createElement } from "react";

export function useLottie() {
  return {
    View: createElement("div", { "data-testid": "lottie-stub" }),
    play: () => {},
    stop: () => {},
    pause: () => {},
    setSpeed: () => {},
    goToAndStop: () => {},
    goToAndPlay: () => {},
    setDirection: () => {},
    getDuration: () => 0,
    destroy: () => {},
    animationItem: null,
  };
}

export default function Lottie() {
  return createElement("div", { "data-testid": "lottie-stub" });
}
