/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { IosSimH264Video } from "./IosSimH264Video";

/**
 * The reader's one security-relevant contract: the helper's frame server
 * authorises on `Authorization: bearer <token>` and STRIPS the query string
 * before it matches the path. A token carried in the URL is therefore never
 * read, and the request is answered 403 — which is what happened until the
 * reader started sending the header.
 */

const originalFetch = globalThis.fetch;

function emptyStreamResponse(): Response {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
      }),
    },
  } as unknown as Response;
}

beforeEach(() => {
  // WebCodecs is absent in jsdom; the component needs the constructors to exist
  // before it will open the connection at all.
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.VideoDecoder = class {
    state = "configured";
    configure() {}
    decode() {}
    close() {}
  };
  scope.EncodedVideoChunk = class {};
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  const scope = globalThis as unknown as Record<string, unknown>;
  delete scope.VideoDecoder;
  delete scope.EncodedVideoChunk;
  vi.restoreAllMocks();
});

describe("IosSimH264Video", () => {
  it("sends the stream token as an Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyStreamResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<IosSimH264Video url="http://127.0.0.1:51234/ios-simulator-video" token="s3cret" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:51234/ios-simulator-video");
    expect(url).not.toContain("s3cret");
    expect(init.headers).toEqual({ authorization: "bearer s3cret" });
  });

  it("omits the header entirely when there is no token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyStreamResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<IosSimH264Video url="http://127.0.0.1:51234/ios-simulator-video" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toBeUndefined();
  });

  it("redials when the token changes, not only when the url does", async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyStreamResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { rerender } = render(
      <IosSimH264Video url="http://127.0.0.1:51234/ios-simulator-video" token="first" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // A stream restart rotates the token on the same loopback port, so a reader
    // keyed only on the url would keep presenting a token the helper has
    // already invalidated.
    rerender(<IosSimH264Video url="http://127.0.0.1:51234/ios-simulator-video" token="second" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.headers).toEqual({ authorization: "bearer second" });
  });

  it("names a 403 as a refused token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
    const onStatus = vi.fn();
    render(<IosSimH264Video url="http://127.0.0.1:51234/x" token="bad" onStatus={onStatus} />);
    await waitFor(() => {
      expect(onStatus).toHaveBeenCalledWith("error", "The simulator video stream refused this token.");
    });
  });
});
