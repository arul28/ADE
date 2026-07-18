import { describe, expect, it } from "vitest";
import { handleRequest, type RelayEnv } from "../src/relay";

// The callback route is stateless and never touches env, so a bare cast is fine.
const env = {} as RelayEnv;

describe("GET /linear/oauth/callback", () => {
  it("302-bounces a success code/state to the app scheme", async () => {
    const response = await handleRequest(
      new Request("https://relay.example/linear/oauth/callback?code=abc123&state=xyz789"),
      env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("ade://linear-oauth?code=abc123&state=xyz789");
  });

  it("URL-encodes code and state values", async () => {
    const response = await handleRequest(
      new Request("https://relay.example/linear/oauth/callback?code=a%2Fb%20c&state=s%2Bt"),
      env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("ade://linear-oauth?code=a%2Fb+c&state=s%2Bt");
  });

  it("bounces an error through without a code", async () => {
    const response = await handleRequest(
      new Request(
        "https://relay.example/linear/oauth/callback?error=access_denied&error_description=User%20declined&state=xyz789",
      ),
      env,
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("ade://linear-oauth?")).toBe(true);
    const params = new URLSearchParams(location.slice("ade://linear-oauth?".length));
    expect(params.get("error")).toBe("access_denied");
    expect(params.get("error_description")).toBe("User declined");
    expect(params.get("state")).toBe("xyz789");
    expect(params.has("code")).toBe(false);
  });

  it("rejects non-GET methods", async () => {
    const response = await handleRequest(
      new Request("https://relay.example/linear/oauth/callback", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(405);
  });
});
