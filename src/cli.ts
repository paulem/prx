import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import type { SystemAdapter } from "./system.ts";

const USAGE_ERROR_EXIT_CODE = 2;
const NOT_IMPLEMENTED_EXIT_CODE = 1;

interface PlannedCommand {
  usage: string;
  description: string;
}

const plannedCommands: PlannedCommand[] = [
  { usage: "run <preset> [passthrough...]", description: "Launch an app through the proxy" },
  { usage: "init", description: "Set up the proxy interactively" },
  { usage: "check", description: "Probe the proxy and report whether it is live" },
  { usage: "list", description: "Show the presets and whether each app is installed" },
  { usage: "config", description: "Print the config path and contents" },
  { usage: "uninstall", description: "Remove prx from this machine" },
];

export async function runCli(argv: readonly string[], system: SystemAdapter): Promise<number> {
  let exitCode = 0;

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
