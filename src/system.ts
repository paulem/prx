/**
 * The single seam between prx and the operating system. Every OS touchpoint
 * goes through here so tests and future wrappers can substitute it
 */
export interface SystemAdapter {
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

export function createNodeSystemAdapter(): SystemAdapter {
  return {
    writeStdout(text) {
      process.stdout.write(text);
    },
    writeStderr(text) {
      process.stderr.write(text);
    },
  };
}
