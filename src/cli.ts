import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runCheck } from "./commands/check.ts";
import { runConfig } from "./commands/config.ts";
import { runList } from "./commands/list.ts";
import { PrxError } from "./errors.ts";
import { createReporter, type Reporter } from "./output.ts";
import { DEFAULT_PROBE_TIMEOUT_MS } from "./probe.ts";
import type { SystemAdapter } from "./system.ts";

const USAGE_ERROR_EXIT_CODE = 2;
const NOT_IMPLEMENTED_EXIT_CODE = 1;

export interface CliOptions {
  probeTimeoutMs?: number;
}

interface PlannedCommand {
  usage: string;
  description: string;
}

const plannedCommands: PlannedCommand[] = [
  { usage: "run <preset> [passthrough...]", description: "Launch an app through the proxy" },
  { usage: "init", description: "Set up the proxy interactively" },
  { usage: "uninstall", description: "Remove prx from this machine" },
];

interface JsonOption {
  json?: boolean;
}

export async function runCli(
  argv: readonly string[],
  system: SystemAdapter,
  options: CliOptions = {},
): Promise<number> {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let exitCode = 0;

  // Commands report their own failures; commander only sees usage errors
  async function report(reporter: Reporter, command: () => Promise<number>): Promise<void> {
    try {
      exitCode = await command();
    } catch (error) {
      if (!(error instanceof PrxError)) {
        throw error;
      }
      reporter.error(error);
      exitCode = error.exitCode;
    }
  }

  const program = new Command("prx")
    .description(pkg.description)
    .version(pkg.version)
    .exitOverride()
    .configureOutput({
      writeOut: system.writeStdout,
      writeErr: system.writeStderr,
    })
    .showHelpAfterError("(add --help for the list of commands)");

  for (const planned of plannedCommands) {
    program
      .command(planned.usage)
      .description(planned.description)
      .action(function notImplemented(this: Command) {
        system.writeStderr(`prx ${this.name()} is not implemented yet\n`);
        exitCode = NOT_IMPLEMENTED_EXIT_CODE;
      });
  }

  program
    .command("check")
    .description("Probe the proxy and report whether it is live")
    .option("--json", "Print the result as one JSON object")
    .action(async (commandOptions: JsonOption) => {
      const reporter = createReporter(system, commandOptions.json === true);
      await report(reporter, () => runCheck({ system, reporter, probeTimeoutMs }));
    });

  program
    .command("list")
    .description("Show the presets and whether each app is installed")
    .option("--json", "Print the result as one JSON object")
    .action(async (commandOptions: JsonOption) => {
      const reporter = createReporter(system, commandOptions.json === true);
      await report(reporter, () => runList({ system, reporter }));
    });

  program
    .command("config")
    .description("Print the config path and contents")
    .option("--json", "Print the result as one JSON object")
    .action(async (commandOptions: JsonOption) => {
      const reporter = createReporter(system, commandOptions.json === true);
      await report(reporter, () => runConfig({ system, reporter }));
    });

  if (argv.length === 0) {
    program.outputHelp();
    return exitCode;
  }

  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    if (error.exitCode === 0) {
      return 0;
    }
    return USAGE_ERROR_EXIT_CODE;
  }
}
