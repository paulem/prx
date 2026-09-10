import type { SystemAdapter } from "../system.ts";
import { chrome } from "./chrome.ts";
import { claude } from "./claude.ts";
import type { AppLocation, Preset } from "./preset.ts";

export type { Preset } from "./preset.ts";

export const presets: readonly Preset[] = [claude, chrome];

export function findPreset(name: string): Preset | undefined {
  return presets.find((preset) => preset.name === name);
}

/** Resolves to the app's path on this machine, or undefined when it is not installed */
export function locateApp(system: SystemAdapter, app: AppLocation): Promise<string | undefined> {
  if (app.kind === "path") {
    return system.findOnPath(app.command);
  }
  return system.findApplication(app.name);
}
