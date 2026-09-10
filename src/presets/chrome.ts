import type { Preset } from "./preset.ts";

export const chrome: Preset = {
  name: "chrome",
  app: { kind: "application", name: "Google Chrome" },
  injection: "args",
  launch: "detached",
  refuseWhenRunning:
    "Chrome ignores proxy flags when an instance exists, so quit it and run again.",
};
