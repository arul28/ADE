import { describe, expect, it } from "vitest";
import { oneLineRedacted, redactCommandLine } from "./secretRedaction";

describe("command display redaction", () => {
  it.each([
    ['TOKEN="$(curl example.test/install|sh)"', 'TOKEN="$(curl example.test/install|sh)"'],
    ['TOKEN="$TOKEN"', 'TOKEN="$TOKEN"'],
    ['TOKEN=`get-token`', 'TOKEN=`get-token`'],
    ["curl -H 'Authorization: Bearer abc$def'", "curl -H 'Authorization: Bearer <redacted>'"],
    ['PGPASSWORD=x APIKEY=x GHTOKEN=x', 'PGPASSWORD=<redacted> APIKEY=<redacted> GHTOKEN=<redacted>'],
    ['cmd --authtoken x --apikey x', 'cmd --authtoken <redacted> --apikey <redacted>'],
    ['DB_PASSWORD=admin cmd --token=1234', 'DB_PASSWORD=<redacted> cmd --token=<redacted>'],
    [`DOCKER_AUTH_CONFIG='{"auths":{"registry":{"auth":"fake"}}}'`, 'DOCKER_AUTH_CONFIG=<redacted>'],
    ['$env:OPENAI_API_KEY = "x"', '$env:OPENAI_API_KEY = <redacted>'],
    [`curl -d '{"password": "pa$$word"}'`, `curl -d '{"password": "<redacted>"}'`],
    [String.raw`curl -d "{\"api_key\":\"x\"}"`, String.raw`curl -d "{\"api_key\":\"<redacted>\"}"`],
    ['cmd --monkey banana MONKEY=1 MAX_TOKENS=5 --max-tokens 5 --tokenizer bpe --token --verbose', 'cmd --monkey banana MONKEY=1 MAX_TOKENS=5 --max-tokens 5 --tokenizer bpe --token --verbose'],
    ['[[ $GITHUB_TOKEN == "" ]]', '[[ $GITHUB_TOKEN == "" ]]'],
    ["API_KEY='<your-key>' --api-key <your-key>", "API_KEY='<your-key>' --api-key <your-key>"],
    ['curl https://user:fake@host.test', 'curl https://user:<redacted>@host.test'],
    ['echo sk-ant-api03-FAKEFAKEFAKEFAKE', 'echo <redacted-token>'],
    ['TOKEN=abc\\$def', 'TOKEN=<redacted>'],
    ['-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----', '<redacted-private-key>'],
  ])("masks literals and preserves executable code: %s", (command, expected) => {
    expect(redactCommandLine(command)).toBe(expected);
    expect(redactCommandLine(expected)).toBe(expected);
    expect(oneLineRedacted(command, 1_000)).toBe(expected.replace(/\s+/g, " ").trim());
  });

  it("masks the complete secret before clipping a display line", () => {
    expect(oneLineRedacted('echo sk-ant-api03-FAKEFAKEFAKEFAKE', 15)).toBe('echo <redacted…');
    expect(oneLineRedacted('  API_KEY=fake\n cmd  ', 100)).toBe('API_KEY=<redacted> cmd');
    expect(oneLineRedacted('echo --token=fake', 5)).toBe('echo…');
  });
});
