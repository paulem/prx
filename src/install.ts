import { join } from "node:path";

// install.sh writes the bundle and the PATH block; uninstall removes exactly what it wrote

export function installedBinaryPath(homeDir: string): string {
  return join(homeDir, ".local", "bin", "prx");
}

export function zshrcPath(homeDir: string): string {
  return join(homeDir, ".zshrc");
}

const PATH_BLOCK_START = "# >>> prx >>>";
const PATH_BLOCK_END = "# <<< prx <<<";
// The block starts on its own line, after a blank line the installer wrote when the file had content
const PATH_BLOCK_PATTERN = new RegExp(
  `(?<=^|\\n)\\n?${PATH_BLOCK_START}\\n[\\s\\S]*?${PATH_BLOCK_END}\\n?`,
);

export function hasPathBlock(zshrc: string): boolean {
  return PATH_BLOCK_PATTERN.test(zshrc);
}

export function removePathBlock(zshrc: string): string {
  return zshrc.replace(PATH_BLOCK_PATTERN, "");
}
