import { hasPathBlock, installedBinaryPath, removePathBlock, zshrcPath } from "../install.ts";
import type { SystemAdapter } from "../system.ts";

export interface UninstallCommand {
  system: SystemAdapter;
  yes: boolean;
}

interface Removal {
  label: string;
  remove: () => Promise<void>;
}

export async function runUninstall({ system, yes }: UninstallCommand): Promise<number> {
  const removals = await plannedRemovals(system);
  if (removals.length === 0) {
    system.writeStdout("Nothing to remove, prx is not installed\n");
    return 0;
  }

  system.writeStdout("prx uninstall will remove:\n");
  for (const removal of removals) {
    system.writeStdout(`  ${removal.label}\n`);
  }

  if (!yes) {
    const answer = await system.prompt.confirm({ message: "Remove these?", initialValue: false });
    if (answer.kind === "cancelled" || !answer.value) {
      system.writeStdout("Nothing removed\n");
      return 0;
    }
  }

  await Promise.all(removals.map((removal) => removal.remove()));
  for (const removal of removals) {
    system.writeStdout(`Removed ${removal.label}\n`);
  }
  return 0;
}

async function plannedRemovals(system: SystemAdapter): Promise<Removal[]> {
  const home = system.homeDir();
  const binary = installedBinaryPath(home);
  const configDir = system.configDir();
  const zshrc = zshrcPath(home);

  const [binaryExists, configDirExists, zshrcText] = await Promise.all([
    system.pathExists(binary),
    system.pathExists(configDir),
    system.readTextFile(zshrc),
  ]);

  const removals: Removal[] = [];
  if (binaryExists) {
    removals.push({ label: binary, remove: () => system.remove(binary) });
  }
  if (configDirExists) {
    removals.push({ label: configDir, remove: () => system.remove(configDir) });
  }
  if (zshrcText !== undefined && hasPathBlock(zshrcText)) {
    removals.push({
      label: `the prx PATH block in ${zshrc}`,
      remove: () => system.writeTextFile(zshrc, removePathBlock(zshrcText)),
    });
  }
  return removals;
}
