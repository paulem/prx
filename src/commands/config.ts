import { configPath, readConfig } from "../config.ts";
import type { Reporter } from "../output.ts";
import type { SystemAdapter } from "../system.ts";

export interface ConfigCommand {
  system: SystemAdapter;
  reporter: Reporter;
}

export async function runConfig({ system, reporter }: ConfigCommand): Promise<number> {
  const path = configPath(system);
  const config = await readConfig(system);
  reporter.result(`${path}\n${JSON.stringify(config, null, 2)}\n`, { path, config });
  return 0;
}
