import { stopBuiltInProxy } from "../builtin-proxy.ts";
import { readConfig } from "../config.ts";
import type { Reporter } from "../output.ts";
import type { SystemAdapter } from "../system.ts";
import { requireBuiltIn } from "./up.ts";

export interface DownCommand {
  system: SystemAdapter;
  reporter: Reporter;
}

export async function runDown({ system, reporter }: DownCommand): Promise<number> {
  const config = await readConfig(system);
  requireBuiltIn(config, "stop");
  const stopped = await stopBuiltInProxy(system);
  const text = stopped ? "Built-in proxy stopped\n" : "Built-in proxy is not running\n";
  reporter.result(text, { stopped });
  return 0;
}
