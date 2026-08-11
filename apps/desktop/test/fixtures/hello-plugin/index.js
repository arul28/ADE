// Fixture plugin for the ADE plugin platform tests.
//
// It is deliberately the smallest thing that touches every half of the SDK a
// real plugin uses: it reads config, writes a collection row, publishes a
// socket contribution, and exposes a named action the host can invoke. Keep it
// dependency-free and CommonJS — the child bootstrap loads it with `require`
// and a plugin is not allowed to assume a bundler ran.

let sdk = null;

exports.activate = async (ade) => {
  sdk = ade;
  const config = await ade.config.get();
  await ade.collections.put("greetings", "boot", {
    greeting: config.greeting ?? "Hello",
    at: new Date().toISOString(),
  });
  ade.log("info", "hello-plugin activated");
};

exports.deactivate = async () => {
  sdk = null;
};

exports.actions = {
  async greet(args) {
    const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "world";
    const config = await sdk.config.get();
    const greeting = `${config.greeting ?? "Hello"}, ${name}`;
    await sdk.collections.put("greetings", `greet:${name}`, { greeting });
    return { greeting };
  },

  async badgeLane(args) {
    await sdk.contributions.publish("lane", String(args.laneId ?? ""), "row-badge", {
      text: "hello",
      tone: "accent",
    });
    return { published: true };
  },

  async boom() {
    throw new Error("hello-plugin failed on purpose");
  },
};
