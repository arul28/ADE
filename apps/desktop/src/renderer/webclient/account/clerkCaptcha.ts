import type { ClerkEnvironment } from "./clerkFrontendApi";

/**
 * Clerk's sign-up bot check: Cloudflare Turnstile, run the way clerk-js runs
 * it (`packages/clerk-js/src/utils/captcha/turnstile.ts`). A "smart" widget
 * renders into the card's captcha slot and stays invisible unless Cloudflare
 * wants a click; an "invisible" one renders off screen. The token goes to
 * Clerk with the sign-up, never anywhere else.
 */

const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** The slot in the sign-in card that a smart widget renders into. */
export const CLERK_CAPTCHA_ELEMENT_ID = "ade-clerk-captcha";
const RETRYABLE_ERROR_PREFIXES = ["crashed", "undefined_error", "102", "103", "104", "106", "110600", "300", "600"];

type TurnstileWidgetOptions = {
  sitekey: string;
  appearance?: "always" | "execute" | "interaction-only";
  theme?: "auto" | "light" | "dark";
  size?: "normal" | "compact" | "flexible" | "invisible";
  action?: string;
  retry?: "auto" | "never";
  "refresh-expired"?: "auto" | "manual" | "never";
  callback?: (token: string) => void;
  "error-callback"?: (code: string | number) => void;
  "before-interactive-callback"?: () => void;
  "unsupported-callback"?: () => boolean | void;
};

type TurnstileApi = {
  render: (container: string | HTMLElement, options: TurnstileWidgetOptions) => string | undefined;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("captcha_script_failed_to_load")));
      script.onerror = () => reject(new Error("captcha_script_failed_to_load"));
      document.head.appendChild(script);
    }).catch((error) => {
      scriptPromise = null;
      throw error;
    });
  }
  return scriptPromise;
}

export type ClerkCaptchaParams = {
  captcha_token?: string;
  captcha_widget_type?: string;
  captcha_error?: string;
};

/**
 * Whether this sign-up must carry a captcha token. Mirrors clerk-js
 * `SignUp.shouldBypassCaptchaForAttempt`: off when the instance does not ask,
 * when Clerk marked this browser as trusted, or for an OAuth transfer from a
 * provider the instance trusts.
 */
export function signUpNeedsCaptcha(env: ClerkEnvironment, args: { captchaBypass: boolean; oauthStrategy?: string | null }): boolean {
  if (!env.signUpCaptchaEnabled || args.captchaBypass) return false;
  if (env.captchaProvider && env.captchaProvider !== "turnstile") return false;
  if (args.oauthStrategy && env.captchaOauthBypass.includes(args.oauthStrategy)) return false;
  return Boolean(env.captchaSiteKey || env.captchaInvisibleSiteKey);
}

/**
 * Runs the challenge and returns the fields Clerk's sign-up expects. A failed
 * challenge still returns `captcha_error`: Clerk decides what that means.
 */
export async function runClerkCaptcha(env: ClerkEnvironment, options: { onInteractive?: () => void } = {}): Promise<ClerkCaptchaParams> {
  const slot = document.getElementById(CLERK_CAPTCHA_ELEMENT_ID);
  const smart = env.captchaWidgetType === "smart" && slot && env.captchaSiteKey;
  const siteKey = smart ? env.captchaSiteKey : env.captchaInvisibleSiteKey ?? env.captchaSiteKey;
  if (!siteKey) return { captcha_error: "captcha_unavailable" };
  let turnstile: TurnstileApi;
  try {
    turnstile = await loadTurnstile();
  } catch {
    return { captcha_error: "captcha_script_failed_to_load" };
  }
  let container: HTMLElement;
  let offscreen: HTMLElement | null = null;
  if (smart && slot) {
    container = slot;
  } else {
    offscreen = document.createElement("div");
    offscreen.style.display = "none";
    document.body.appendChild(offscreen);
    container = offscreen;
  }
  const widgetType = smart ? "smart" : "invisible";
  const errors: string[] = [];
  let retries = 0;
  let widgetId: string | undefined;
  try {
    const token = await new Promise<string>((resolve, reject) => {
      try {
        widgetId = turnstile.render(container, {
          sitekey: siteKey,
          appearance: "interaction-only",
          theme: "auto",
          size: "flexible",
          action: "signup",
          retry: "never",
          "refresh-expired": "auto",
          callback: resolve,
          "before-interactive-callback": () => options.onInteractive?.(),
          "error-callback": (code) => {
            const text = String(code);
            errors.push(text);
            if (retries < 2 && RETRYABLE_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix))) {
              retries += 1;
              window.setTimeout(() => turnstile.reset(widgetId), 250);
              return;
            }
            reject(new Error(errors.join(",")));
          },
          "unsupported-callback": () => {
            reject(new Error("This browser is not supported by the CAPTCHA."));
            return true;
          },
        });
      } catch (error) {
        reject(error);
      }
    });
    return { captcha_token: token, captcha_widget_type: widgetType };
  } catch (error) {
    return {
      captcha_error: error instanceof Error ? error.message : "unexpected_captcha_error",
      captcha_widget_type: widgetType,
    };
  } finally {
    if (widgetId) {
      try {
        turnstile.remove(widgetId);
      } catch {
        // The widget is already gone.
      }
    }
    offscreen?.remove();
  }
}
