export type SubscriptionProxyProvider = "claude" | "codex";

export type SubscriptionProxyLogin = {
  loginId: string;
  provider: string;
  email: string | null;
  plan: string | null;
  prefix: string | null;
  disabled: boolean;
};

export type SubscriptionProxyStatus = {
  installed: boolean;
  running: boolean;
  port: number | null;
  version: string | null;
  logins: SubscriptionProxyLogin[];
};

export type SubscriptionProxySignInArgs = {
  provider: SubscriptionProxyProvider;
};

export type SubscriptionProxySignInResult = {
  status: "ok" | "error" | "timeout";
  login?: SubscriptionProxyLogin;
  error?: string;
};

export type SubscriptionProxySignOutArgs = {
  loginId: string;
};

export type SubscriptionProxySetDisabledArgs = {
  loginId: string;
  disabled: boolean;
};

export type SubscriptionProxyMutationResult = {
  ok: true;
  login?: SubscriptionProxyLogin;
};
