import { configPath, parseProxyAddress, proxyUrl, writeConfig, type Config } from "../config.ts";
import { PrxError } from "../errors.ts";
import { DEFAULT_PROBE_URL, probe } from "../probe.ts";
import type { PromptAnswer, SystemAdapter } from "../system.ts";
import { formatPresetListing, listPresets } from "./list.ts";

export interface InitCommand {
  system: SystemAdapter;
  probeTimeoutMs: number;
}

const DEFAULT_ADDRESS = "127.0.0.1:8118";

export async function runInit(command: InitCommand): Promise<number> {
  await initWizard(command);
  return 0;
}

/** Asks for the proxy, probes it, and writes the config; throws when the person backs out */
export async function initWizard({ system, probeTimeoutMs }: InitCommand): Promise<Config> {
  const type = answerOrCancel(
    await system.prompt.select<"http">({
      message: "Proxy type",
      options: [{ value: "http", label: "HTTP proxy, no auth" }],
    }),
  );

  const address = answerOrCancel(
    await system.prompt.text({
      message: "Proxy address (host:port or http://host:port)",
      initialValue: DEFAULT_ADDRESS,
      validate(input) {
        const parsed = parseProxyAddress(input);
        return parsed.ok ? undefined : parsed.message;
      },
    }),
  );
  const parsed = parseProxyAddress(address);
  if (!parsed.ok) {
    throw new Error(`validated address failed to parse: ${parsed.message}`);
  }
  const proxy = { ...parsed.proxy, type };

  const result = await probe(proxy, { url: DEFAULT_PROBE_URL, timeoutMs: probeTimeoutMs });
  if (result.live) {
    system.writeStdout(`Proxy ${proxyUrl(proxy)} is live (${result.latencyMs} ms)\n`);
  } else {
    system.writeStdout(`Proxy ${proxyUrl(proxy)} is not live: ${result.message}\n`);
    const saveAnyway = answerOrCancel(
      await system.prompt.confirm({ message: "Save the config anyway?", initialValue: false }),
    );
    if (!saveAnyway) {
      throw cancelled();
    }
  }

  const config: Config = { version: 1, proxy };
  await writeConfig(system, config);
  system.writeStdout(`Saved config to ${configPath(system)}\n`);
  system.writeStdout(formatPresetListing(await listPresets(system)));
  return config;
}

function answerOrCancel<T>(answer: PromptAnswer<T>): T {
  if (answer.kind === "cancelled") {
    throw cancelled();
  }
  return answer.value;
}

function cancelled(): PrxError {
  return new PrxError("cancelled", "Cancelled, nothing was saved");
}
