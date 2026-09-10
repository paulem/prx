import type { Reporter } from "../output.ts";
import { locateApp, presets } from "../presets/index.ts";
import type { SystemAdapter } from "../system.ts";

export interface ListCommand {
  system: SystemAdapter;
  reporter: Reporter;
}

export interface PresetListing {
  name: string;
  found: boolean;
  launch: "attached" | "detached";
}

export async function listPresets(system: SystemAdapter): Promise<PresetListing[]> {
  return Promise.all(
    presets.map(async (preset) => ({
      name: preset.name,
      found: (await locateApp(system, preset.app)) !== undefined,
      launch: preset.launch,
    })),
  );
}

export function formatPresetListing(listing: PresetListing[]): string {
  const nameWidth = Math.max(...listing.map((entry) => entry.name.length));
  return listing
    .map((entry) => {
      const found = entry.found ? "found  " : "missing";
      return `${entry.name.padEnd(nameWidth)}  ${found}  ${entry.launch}\n`;
    })
    .join("");
}

export async function runList({ system, reporter }: ListCommand): Promise<number> {
  const listing = await listPresets(system);
  reporter.result(formatPresetListing(listing), { presets: listing });
  return 0;
}
