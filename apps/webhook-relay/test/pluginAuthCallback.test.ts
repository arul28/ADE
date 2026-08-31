import { describe, expect, it } from "vitest";
import { handleRequest, type RelayEnv } from "../src/relay";

// The callback route is stateless and never touches env, so a bare cast is fine.
const env = {} as RelayEnv;

const PREFIX = "ade://plugin-auth?";

function locationParams(response: Response): URLSearchParams {
  const location = response.headers.get("location") ?? "";
  expect(location.startsWith(PREFIX)).toBe(true);
  return new URLSearchParams(location.slice(PREFIX.length));
}

describe("GET /plugin/auth/callback", () => {
  it("302-bounces a success code/state to the app scheme", async () => {
    const response = await handleRequest(
      new Request("https://relay.example/plugin/auth/callback?code=abc123&state=xyz789"),
      env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("ade://plugin-auth?code=abc123&state=xyz789");
  });

  it("rejects non-GET methods", async () => {
    const response = await handleRequest(
      new Request("https://relay.example/plugin/auth/callback", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(405);
  });

  it("bounces an error through without a code", async () => {
    const response = await handleRequest(
      new Request(
        "https://relay.example/plugin/auth/callback?error=access_denied&error_description=User%20declined&state=xyz789",
      ),
      env,
    );
    expect(response.status).toBe(302);
    const params = locationParams(response);
    expect(params.get("error")).toBe("access_denied");
    expect(params.get("error_description")).toBe("User declined");
    expect(params.get("state")).toBe("xyz789");
    expect(params.has("code")).toBe(false);
  });

  it("passes through a parameter the route has never heard of", async () => {
    // The whole reason this route exists beside the Linear one: it serves every
    // plugin, so a provider-specific field it cannot anticipate must survive.
    const response = await handleRequest(
      new Request(
        "https://relay.example/plugin/auth/callback?code=abc&state=s1&scope=repo%3Aread&team_id=T42",
      ),
      env,
    );
    const params = locationParams(response);
    expect(params.get("code")).toBe("abc");
    expect(params.get("state")).toBe("s1");
    expect(params.get("scope")).toBe("repo:read");
    expect(params.get("team_id")).toBe("T42");
  });

  it("keeps the first value of a repeated parameter and emits it once", async () => {
    const response = await handleRequest(
      new Request("https://relay.example/plugin/auth/callback?code=abc&state=s1&scope=one&scope=two"),
      env,
    );
    const params = locationParams(response);
    expect(params.getAll("scope")).toEqual(["one"]);
  });

  it("still emits state when the provider sent none, so the app can see it is unroutable", async () => {
    const response = await handleRequest(
      new Request("https://relay.example/plugin/auth/callback?code=abc"),
      env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("ade://plugin-auth?code=abc&state=");
  });

  it("emits %20 (not +) for spaces so iOS URLComponents renders readable text", async () => {
    const response = await handleRequest(
      new Request(
        "https://relay.example/plugin/auth/callback?error=access_denied&error_description=User%20declined%20access&state=s1",
      ),
      env,
    );
    const location = response.headers.get("location") ?? "";
    // iOS reads this with URLComponents, which leaves "+" intact, so spaces must
    // be %20 or the connect screen would show "User+declined+access".
    expect(location).toContain("error_description=User%20declined%20access");
    expect(location).not.toContain("+");
  });

  it("caps how many parameters reach the app", async () => {
    const extras = Array.from({ length: 40 }, (_, index) => `x${index}=v`).join("&");
    const response = await handleRequest(
      new Request(`https://relay.example/plugin/auth/callback?code=abc&state=s1&${extras}`),
      env,
    );
    const params = locationParams(response);
    expect([...params.keys()].length).toBe(24);
    // The fields the host routes on are written before the pass-through, so the
    // cap can only ever eat parameters the host does not need.
    expect(params.get("code")).toBe("abc");
    expect(params.get("state")).toBe("s1");
  });

  it("drops an oversized pass-through parameter rather than clipping it", async () => {
    const huge = "z".repeat(8_000);
    const response = await handleRequest(
      new Request(`https://relay.example/plugin/auth/callback?code=abc&state=s1&blob=${huge}`),
      env,
    );
    const location = response.headers.get("location") ?? "";
    expect(location.length).toBeLessThanOrEqual(PREFIX.length + 4096);
    const params = locationParams(response);
    expect(params.has("blob")).toBe(false);
    expect(params.get("code")).toBe("abc");
    expect(params.get("state")).toBe("s1");
  });

  it("refuses a callback whose own code/state already blow the budget", async () => {
    const response = await handleRequest(
      new Request(`https://relay.example/plugin/auth/callback?code=${"z".repeat(8_000)}&state=s1`),
      env,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});
