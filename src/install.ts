import { join } from "node:path";

/** Where install.sh puts the bundle and marks its PATH export; uninstall removes exactly these */
export function installedBinaryPath(homeDir: string): string {
  return join(homeDir, ".local", "bin", "prx");
}

export function zshrcPath(homeDir: string): string {
  return join(homeDir, ".zshrc");
}

const PATH_BLOCK_START = "# >>> prx >>>";
const PATH_BLOCK_END = "# <<< prx <<<";
// The installer writes a blank line before the block; that line goes with it
const PATH_BLOCK_PATTERN = new RegExp(`\\n?${PATH_BLOCK_START}\\n[\\s\\S]*?${PATH_BLOCK_END}\\n?`);

export function hasPathBlock(zshrc: string): boolean {
  return PATH_BLOCK_PATTERN.test(zshrc);
}

export function removePathBlock(zshrc: string): string {
  return zshrc.replace(PATH_BLOCK_PATTERN, "");
}
