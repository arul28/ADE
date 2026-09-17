import { describe, expect, it } from "vitest";

import { SCENE_CONTENT_SECURITY_POLICY } from "../../../shared/chatScene";
import { createSceneDocumentStore, parseSceneRequestId } from "./sceneDocumentStore";

describe("scene document store", () => {
  it("serves a prepared document with the scene policy headers", () => {
    const store = createSceneDocumentStore();
    const prepared = store.put("<!doctype html><p>hello</p>");

    expect(prepared.url).toBe(`ade-scene://view/${prepared.id}`);

    const response = store.respond(prepared.url);
    expect(response.status).toBe(200);
    expect(response.body).toBe("<!doctype html><p>hello</p>");
    expect(response.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["Content-Security-Policy"]).toBe(SCENE_CONTENT_SECURITY_POLICY);
    expect(response.headers["Referrer-Policy"]).toBe("no-referrer");
  });

  it("404s an unknown id, a foreign scheme, and a URL with no id", () => {
    const store = createSceneDocumentStore();
    store.put("<p>known</p>");

    for (const url of [
      "ade-scene://view/does-not-exist",
      "ade-artifact://view/anything",
      "ade-scene://view/",
      "ade-scene://other/abc",
      "ade-scene://view/a/b",
      "not a url",
    ]) {
      const response = store.respond(url);
      expect(response.status, url).toBe(404);
      expect(response.headers["Content-Security-Policy"], url).toBeUndefined();
    }
  });

  it("never serves anything it was not handed — there is no path to read", () => {
    const store = createSceneDocumentStore();
    expect(store.respond("ade-scene://view/../../etc/passwd").status).toBe(404);
    expect(store.respond("ade-scene:///etc/passwd").status).toBe(404);
  });

  it("evicts the oldest document once the cap is reached", () => {
    let counter = 0;
    const store = createSceneDocumentStore({ capacity: 3, makeId: () => `id-${counter++}` });

    const first = store.put("<p>1</p>");
    const second = store.put("<p>2</p>");
    store.put("<p>3</p>");
    expect(store.size()).toBe(3);
    expect(store.respond(first.url).status).toBe(200);

    const fourth = store.put("<p>4</p>");
    expect(store.size()).toBe(3);
    expect(store.respond(first.url).status).toBe(404);
    expect(store.respond(second.url).status).toBe(200);
    expect(store.respond(fourth.url).status).toBe(200);
  });

  it("accepts both the authority and rooted URL spellings", () => {
    expect(parseSceneRequestId("ade-scene://view/abc123")).toBe("abc123");
    expect(parseSceneRequestId("ade-scene:///view/abc123")).toBe("abc123");
    expect(parseSceneRequestId("ade-scene://view/abc%2Fdef")).toBe("abc/def");
    expect(parseSceneRequestId("https://view/abc123")).toBeNull();
  });
});
