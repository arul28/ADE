import { describe, expect, it } from "vitest";
import { githubAttachmentCanonicalUrl, githubSignedMediaUrl } from "./githubMedia";

const UUID = "d6d606f0-7961-4975-a055-3cb57cf05772";

// The token is attached only to a URL `githubAttachmentCanonicalUrl` accepts,
// and the renderer is only handed a URL `githubSignedMediaUrl` accepts.
describe("GitHub attachment URL allowlist", () => {
  it.each([
    ["user attachment", `https://github.com/user-attachments/assets/${UUID}`, `https://github.com/user-attachments/assets/${UUID}`],
    ["older repo attachment", `https://github.com/arul28/crumb/assets/31745423/${UUID}`, `https://github.com/arul28/crumb/assets/31745423/${UUID}`],
    ["fragment dropped", `https://github.com/user-attachments/assets/${UUID}#x`, `https://github.com/user-attachments/assets/${UUID}`],
    ["plain http", `http://github.com/user-attachments/assets/${UUID}`, null],
    ["look-alike host", `https://github.com.evil.test/user-attachments/assets/${UUID}`, null],
    ["subdomain", `https://api.github.com/user-attachments/assets/${UUID}`, null],
    ["credentials in URL", `https://user:pw@github.com/user-attachments/assets/${UUID}`, null],
    ["explicit port", `https://github.com:8443/user-attachments/assets/${UUID}`, null],
    ["query string", `https://github.com/user-attachments/assets/${UUID}?return_to=/login`, null],
    ["sign-in page", "https://github.com/login?return_to=%2Fuser-attachments", null],
    ["path traversal", `https://github.com/user-attachments/assets/../../login/${UUID}`, null],
    ["not a uuid", "https://github.com/user-attachments/assets/12345", null],
    ["dot repo", `https://github.com/arul28/../assets/1/${UUID}`, null],
    ["internal address", "https://169.254.169.254/latest/meta-data", null],
    ["signed copy is not re-resolved", `https://private-user-images.githubusercontent.com/1/2-${UUID}.png?jwt=a.b.c`, null],
  ])("input: %s", (_label, url, expected) => {
    expect(githubAttachmentCanonicalUrl(url)).toBe(expected);
  });

  it.each([
    ["private-user-images with jwt", "https://private-user-images.githubusercontent.com/1/2-x.png?jwt=a.b.c", true],
    ["asset bucket with signature", "https://github-production-user-asset-6210df.s3.amazonaws.com/1/x?X-Amz-Signature=abc&response-content-type=video%2Fmp4", true],
    ["private-user-images unsigned", "https://private-user-images.githubusercontent.com/1/2-x.png", false],
    ["asset bucket unsigned", "https://github-production-user-asset-6210df.s3.amazonaws.com/1/x", false],
    ["another bucket", "https://evil.s3.amazonaws.com/x?X-Amz-Signature=abc", false],
    ["sign-in redirect", "https://github.com/login?return_to=x&jwt=a", false],
    ["plain http", "http://private-user-images.githubusercontent.com/1/x?jwt=a", false],
    ["port", "https://private-user-images.githubusercontent.com:444/1/x?jwt=a", false],
    ["relative", "/login?jwt=a", false],
  ])("signed source: %s", (_label, url, accepted) => {
    expect(githubSignedMediaUrl(url) !== null).toBe(accepted);
  });
});
