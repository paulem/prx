import type { EndpointType } from "../config.ts";
import type { Reporter, View } from "../output.ts";
import { locateApp, presets } from "../presets/index.ts";
import { bold, dim, symbolCell, table, type Cell } from "../style.ts";
import type { SystemAdapter } from "../system.ts";

export interface ListCommand {
  system: SystemAdapter;
  reporter: Reporter;
}

export interface PresetListing {
  name: string;
  found: boolean;
  launch: "attached" | "detached";
  endpoints: EndpointType[];
}

export async function listPresets(system: SystemAdapter): Promise<PresetListing[]> {
  return Promise.all(
    presets.map(async (preset) => ({
      name: preset.name,
      found: (await locateApp(system, preset.app)) !== undefined,
      launch: preset.launch,
      endpoints: preset.endpoints,
    })),
  );
}

export function formatPresetListing(listing: PresetListing[]): string {
  const nameWidth = Math.max(...listing.map((entry) => entry.name.length));
  return listing
    .map((entry) => {
      const found = entry.found ? "found  " : "missing";
      const endpoints = entry.endpoints.join(",");
      return `${entry.name.padEnd(nameWidth)}  ${found}  ${entry.launch}  ${endpoints}\n`;
    })
    .join("");
}

/** A header row, then one row per preset marked installed or not, with the secondary facts dimmed */
export function presetRows(listing: PresetListing[]): string[] {
  const header: Cell[] = [
    { text: " " },
    { text: "Preset", style: dim },
    { text: "Launch", style: dim },
    { text: "Endpoints", style: dim },
  ];
  const rows = listing.map((entry): Cell[] => {
    const endpoints = entry.endpoints.join(", ");
    if (entry.found) {
      return [
        symbolCell("success"),
        { text: entry.name, style: bold },
        { text: entry.launch, style: dim },
        { text: endpoints, style: dim },
      ];
    }
    return [
      symbolCell("muted"),
      { text: entry.name, style: dim },
      { text: entry.launch, style: dim },
      { text: endpoints, style: dim },
      { text: "not installed", style: dim },
    ];
  });
  return table([header, ...rows]);
}

export function listView(listing: PresetListing[]): View {
  return {
    plain: formatPresetListing(listing),
    decorated: presetRows(listing)
      .map((row) => `${row}\n`)
      .join(""),
  };
}

export async function runList({ system, reporter }: ListCommand): Promise<number> {
  const listing = await listPresets(system);
  reporter.result(listView(listing), { presets: listing });
  return 0;
}
