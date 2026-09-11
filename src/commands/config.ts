import { configPath, readConfig } from "../config.ts";
import type { Reporter } from "../output.ts";
import { pathLink, renderBlock, symbol } from "../style.ts";
import type { SystemAdapter } from "../system.ts";

export interface ConfigCommand {
  system: SystemAdapter;
  reporter: Reporter;
}

export async function runConfig({ system, reporter }: ConfigCommand): Promise<number> {
  const path = configPath(system);
  const config = await readConfig(system);
  const contents = JSON.stringify(config, null, 2);
  reporter.result(
    {
      plain: `${path}\n${contents}\n`,
      decorated:
        renderBlock({ mark: symbol("muted"), lines: [pathLink(system.homeDir(), path)] }) +
        `${contents}\n`,
    },
    { path, config },
  );
  return 0;
}
