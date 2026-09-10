import type { Preset } from "./preset.ts";

export const claude: Preset = {
  name: "claude",
  app: { kind: "path", command: "claude" },
  injection: "env",
  launch: "attached",
  probeUrl: "https://api.anthropic.com/",
};
