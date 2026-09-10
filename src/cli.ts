import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import type { SystemAdapter } from "./system.ts";

const USAGE_ERROR_EXIT_CODE = 2;

interface PlannedCommand {
  name: string;
  description: string;
}

const plannedCommands: PlannedCommand[] = [
  { name: "run <preset> [passthrough...]", description: "Launch an app through the proxy" },
  { name: "init", description: "Set up the proxy interactively" },
  { name: "check", description: "Probe the proxy and report whether it is live" },
  { name: "list", description: "Show the presets and whether each app is installed" },
  { name: "config", description: "Print the config path and contents" },
  { name: "uninstall", description: "Remove prx from this machine" },
];

export async function runCli(argv: readonly string[], system: SystemAdapter): Promise<number> {
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
      .command(planned.name)
      .description(planned.description)
      .action(function notImplemented(this: Command) {
        this.error(`prx ${this.name()} is not implemented yet`, { code: "prx.notImplemented" });
      });
  }

  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    if (error.exitCode === 0) {
      return 0;
    }
    if (error.code.startsWith("commander.")) {
      return USAGE_ERROR_EXIT_CODE;
    }
    return error.exitCode;
  }
}
