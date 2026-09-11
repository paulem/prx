import * as clack from "@clack/prompts";
import { stopBuiltInProxy } from "../builtin-proxy.ts";
import { hasPathBlock, installedBinaryPath, removePathBlock, zshrcPath } from "../install.ts";
import type { Reporter } from "../output.ts";
import { bold, pathLink, renderBlock, symbol } from "../style.ts";
import type { SystemAdapter } from "../system.ts";

export interface UninstallCommand {
  system: SystemAdapter;
  reporter: Reporter;
  yes: boolean;
}

interface Removal {
  label: string;
  /** The label with its path linked, for a decorated terminal */
  decoratedLabel: string;
  remove: () => Promise<void>;
}

export async function runUninstall({ system, reporter, yes }: UninstallCommand): Promise<number> {
  const removals = await plannedRemovals(system);
  if (removals.length === 0) {
    const text = "Nothing to remove, prx is not installed";
    reporter.result(
      { plain: `${text}\n`, decorated: renderBlock({ mark: symbol("muted"), lines: [text] }) },
      {},
    );
    return 0;
  }

  const plainList = removals.map((removal) => `  ${removal.label}\n`).join("");
  reporter.step(`prx uninstall will remove:\n${plainList}`, (output) => {
    clack.intro(bold("prx uninstall"), { output });
    const list = removals.map((removal) => removal.decoratedLabel).join("\n");
    clack.note(list, "Will remove", { output });
  });

  if (!yes) {
    const answer = await system.prompt.confirm({ message: "Remove these?", initialValue: false });
    if (answer.kind === "cancelled" || !answer.value) {
      reporter.step("Nothing removed\n", (output) => clack.cancel("Nothing removed", { output }));
      return 0;
    }
  }

  await Promise.all(removals.map((removal) => removal.remove()));
  for (const removal of removals) {
    reporter.step(`Removed ${removal.label}\n`, (output) =>
      clack.log.step(`Removed ${removal.decoratedLabel}`, { output }),
    );
  }
  reporter.step("", (output) => clack.outro("prx is gone from this machine", { output }));
  return 0;
}

async function plannedRemovals(system: SystemAdapter): Promise<Removal[]> {
  const home = system.homeDir();
  const binary = installedBinaryPath(home);
  const configDir = system.configDir();
  const stateDir = system.stateDir();
  const zshrc = zshrcPath(home);

  const [binaryExists, configDirExists, stateDirExists, zshrcText] = await Promise.all([
    system.pathExists(binary),
    system.pathExists(configDir),
    system.pathExists(stateDir),
    system.readTextFile(zshrc),
  ]);

  const removals: Removal[] = [];
  if (binaryExists) {
    removals.push({
      label: binary,
      decoratedLabel: pathLink(home, binary),
      remove: () => system.remove(binary),
    });
  }
  if (configDirExists) {
    removals.push({
      label: configDir,
      decoratedLabel: pathLink(home, configDir),
      remove: () => system.remove(configDir),
    });
  }
  if (stateDirExists) {
    // Nothing prx started may outlive it, so the proxy is stopped before its state goes
    removals.push({
      label: stateDir,
      decoratedLabel: pathLink(home, stateDir),
      remove: async () => {
        await stopBuiltInProxy(system);
        await system.remove(stateDir);
      },
    });
  }
  if (zshrcText !== undefined && hasPathBlock(zshrcText)) {
    removals.push({
      label: `the prx PATH block in ${zshrc}`,
      decoratedLabel: `the prx PATH block in ${pathLink(home, zshrc)}`,
      remove: () => system.writeTextFile(zshrc, removePathBlock(zshrcText)),
    });
  }
  return removals;
}
