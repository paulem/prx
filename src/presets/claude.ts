import type { Preset } from "./preset.ts";

export const claude: Preset = {
  name: "claude",
  app: { kind: "path", command: "claude" },
  injection: "env",
  // Claude Code documents that it does not support SOCKS proxies
  endpoints: ["http"],
  launch: "attached",
  probeUrl: "https://api.anthropic.com/",
};
