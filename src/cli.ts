import { Command, CommanderError, Option } from "commander";
import pkg from "../package.json" with { type: "json" };
import { DEFAULT_START_TIMEOUT_MS } from "./builtin-proxy.ts";
import { runConfig } from "./commands/config.ts";
import { runDown } from "./commands/down.ts";
import { runInit } from "./commands/init.ts";
import { runList } from "./commands/list.ts";
import { DEFAULT_QUIT_WAIT_MS, runRun } from "./commands/run.ts";
import { runStatus } from "./commands/status.ts";
import { runUp } from "./commands/up.ts";
import { runUninstall } from "./commands/uninstall.ts";
import { ENDPOINT_TYPES, type EndpointType } from "./config.ts";
import { PrxError } from "./errors.ts";
import { createReporter, type Reporter } from "./output.ts";
import { DEFAULT_PROBE_TIMEOUT_MS } from "./probe.ts";
import { bold, cyan, green, yellow } from "./style.ts";
import type { SystemAdapter } from "./system.ts";

const USAGE_ERROR_EXIT_CODE = 2;

export interface CliOptions {
  probeTimeoutMs?: number;
  startTimeoutMs?: number;
  quitWaitMs?: number;
}

interface JsonOption {
  json?: boolean;
}

interface RunOptions extends JsonOption {
  check: boolean;
  via?: EndpointType;
}

interface YesOption {
  yes?: boolean;
}

export async function runCli(
  argv: readonly string[],
  system: SystemAdapter,
  options: CliOptions = {},
): Promise<number> {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const quitWaitMs = options.quitWaitMs ?? DEFAULT_QUIT_WAIT_MS;
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
      getOutHasColors: () => system.decorates("stdout"),
      getErrHasColors: () => system.decorates("stderr"),
    })
    .showHelpAfterError("(add --help for the list of commands)")
    .enablePositionalOptions()
    .addHelpText("after", `\n${helpExamples(system.decorates("stdout"))}`);

  if (system.decorates("stdout")) {
    program.configureHelp({
      styleTitle: bold,
      styleCommandText: cyan,
      styleSubcommandTerm: cyan,
      styleOptionTerm: green,
      styleArgumentTerm: yellow,
    });
  }

  program
    .command("run")
    .description("Launch an app through the proxy, starting a built-in proxy first when needed")
    .argument("<preset>", "The app to launch: claude or chrome")
    .argument("[passthrough...]", "Arguments handed to the app verbatim")
    .option("--no-check", "Skip the probe and launch anyway")
    .addOption(
      new Option(
        "--via <type>",
        "Inject this endpoint type instead of the preset's preference",
      ).choices([...ENDPOINT_TYPES]),
    )
    .option("--json", "Print the launch as one JSON object")
    .passThroughOptions()
    .action(async (presetName: string, passthrough: string[], commandOptions: RunOptions) => {
      const json = commandOptions.json === true;
      const reporter = createReporter(system, json);
      await report(reporter, () =>
        runRun({
          system,
          reporter,
          probeTimeoutMs,
          startTimeoutMs,
          quitWaitMs,
          presetName,
          passthrough,
          check: commandOptions.check,
          json,
          ...(commandOptions.via === undefined ? {} : { via: commandOptions.via }),
        }),
      );
    });

  program
    .command("init")
    .description("Set up an external or built-in proxy interactively")
    .action(async () => {
      const reporter = createReporter(system, false);
      await report(reporter, () => runInit({ system, reporter, probeTimeoutMs, startTimeoutMs }));
    });

  program
    .command("up")
    .description("Start the built-in proxy in the background and wait for its endpoints")
    .option("--json", "Print the result as one JSON object")
    .action(async (commandOptions: JsonOption) => {
      const reporter = createReporter(system, commandOptions.json === true);
      await report(reporter, () => runUp({ system, reporter, probeTimeoutMs, startTimeoutMs }));
    });

  program
    .command("down")
    .description("Stop the built-in proxy")
    .option("--json", "Print the result as one JSON object")
    .action(async (commandOptions: JsonOption) => {
      const reporter = createReporter(system, commandOptions.json === true);
      await report(reporter, () => runDown({ system, reporter }));
    });

  program
    .command("status")
    .description("Report whether the built-in proxy is running and whether each endpoint is live")
    .option("--json", "Print the result as one JSON object")
    .action(async (commandOptions: JsonOption) => {
      const reporter = createReporter(system, commandOptions.json === true);
      await report(reporter, () => runStatus({ system, reporter, probeTimeoutMs }));
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

  program
    .command("uninstall")
    .description("Remove prx from this machine")
    .option("--yes", "Remove without asking")
    .action(async (commandOptions: YesOption) => {
      const reporter = createReporter(system, false);
      await report(reporter, () =>
        runUninstall({ system, reporter, yes: commandOptions.yes === true }),
      );
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

const EXAMPLES: [string, string][] = [
  ["prx init", "set up a proxy"],
  ["prx run claude", "launch Claude Code through it"],
  ["prx run chrome --via socks", "launch Chrome on the SOCKS endpoint"],
  ["prx status", "see whether the proxy is live"],
];

function helpExamples(decorated: boolean): string {
  const width = Math.max(...EXAMPLES.map(([command]) => command.length));
  const lines = EXAMPLES.map(([command, purpose]) => {
    const padded = command.padEnd(width);
    return `  ${decorated ? cyan(padded) : padded}  ${purpose}`;
  });
  const title = decorated ? bold("Examples:") : "Examples:";
  return `${title}\n${lines.join("\n")}\n`;
}
