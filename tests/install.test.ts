import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { isolatedHomeEnv, runNode, type ProcessResult } from "./built-bundle.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const INSTALL_SCRIPT = join(REPO_ROOT, "install.sh");
const PATH_BLOCK = '# >>> prx >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< prx <<<\n';
const ZSHRC_BEFORE = "alias ll='ls -l'\n";
// Each install runs the real bundle build
const INSTALL_TIMEOUT_MS = 30_000;

// Stands in for pnpm so the installer needs neither the network nor the user's package caches:
// records every call and performs only the build, with the checkout's own tsup
const FAKE_PNPM = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_PNPM_LOG"
case " $* " in
  *" build "*) exec "${join(REPO_ROOT, "node_modules", ".bin", "tsup")}" --silent ;;
esac
`;

interface Home {
  dir: string;
  binary: string;
  zshrc: string;
  fakeBin: string;
  pnpmLog: string;
}

async function freshHome(): Promise<Home> {
  const dir = await mkdtemp(join(tmpdir(), "prx-install-"));
  const fakeBin = join(dir, "fake-bin");
  await mkdir(fakeBin);
  await writeExecutable(join(fakeBin, "pnpm"), FAKE_PNPM);
  await writeFile(join(dir, ".zshrc"), ZSHRC_BEFORE);
  return {
    dir,
    binary: join(dir, ".local", "bin", "prx"),
    zshrc: join(dir, ".zshrc"),
    fakeBin,
    pnpmLog: join(dir, "pnpm.log"),
  };
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

interface InstallOptions {
  args?: string[];
  pathPrefix?: string[];
}

function runInstall(home: Home, options: InstallOptions = {}): Promise<ProcessResult> {
  const path = [home.fakeBin, ...(options.pathPrefix ?? []), process.env.PATH].join(delimiter);
  const env = isolatedHomeEnv(home.dir, { PATH: path, FAKE_PNPM_LOG: home.pnpmLog });
  return new Promise((resolve) => {
    execFile(
      "bash",
      [INSTALL_SCRIPT, ...(options.args ?? [])],
      { cwd: tmpdir(), env },
      (error, stdout, stderr) => {
        let exitCode: number | null = 0;
        if (error) {
          exitCode = typeof error.code === "number" ? error.code : null;
        }
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("install.sh on a fresh machine", () => {
  let home: Home;
  let result: ProcessResult;

  beforeAll(async () => {
    home = await freshHome();
    result = await runInstall(home);
  }, INSTALL_TIMEOUT_MS);

  test("succeeds and says what it did", () => {
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `Installed prx to ${home.binary}\n` +
        `Added ${home.dir}/.local/bin to PATH in ${home.zshrc}, open a new shell to use prx\n`,
    );
  });

  test("installs dependencies from the lockfile, then builds", async () => {
    expect(await readFile(home.pnpmLog, "utf8")).toBe(
      "install --frozen-lockfile --silent\n--silent build\n",
    );
  });

  test("puts a runnable bundle at ~/.local/bin/prx", async () => {
    const info = await stat(home.binary);
    expect(info.mode & 0o111).not.toBe(0);

    const version = await runNode([home.binary, "--version"]);
    expect(version).toEqual({ exitCode: 0, stdout: `${pkg.version}\n`, stderr: "" });
  });

  test("appends the marked PATH block to .zshrc", async () => {
    expect(await readFile(home.zshrc, "utf8")).toBe(`${ZSHRC_BEFORE}\n${PATH_BLOCK}`);
  });
});

describe("install.sh re-run and opt-outs", () => {
  test(
    "re-running keeps a single PATH block",
    async () => {
      const home = await freshHome();
      await runInstall(home);

      const result = await runInstall(home);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`Installed prx to ${home.binary}\n`);
      expect(await readFile(home.zshrc, "utf8")).toBe(`${ZSHRC_BEFORE}\n${PATH_BLOCK}`);
    },
    INSTALL_TIMEOUT_MS,
  );

  test(
    "--no-modify-path leaves .zshrc alone",
    async () => {
      const home = await freshHome();

      const result = await runInstall(home, { args: ["--no-modify-path"] });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        `Installed prx to ${home.binary}\n` +
          `${home.dir}/.local/bin is not on PATH, add it yourself to use prx\n`,
      );
      expect(await readFile(home.zshrc, "utf8")).toBe(ZSHRC_BEFORE);
    },
    INSTALL_TIMEOUT_MS,
  );

  test(
    "skips the PATH block when ~/.local/bin is already on PATH",
    async () => {
      const home = await freshHome();

      const result = await runInstall(home, { pathPrefix: [join(home.dir, ".local", "bin")] });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`Installed prx to ${home.binary}\n`);
      expect(await readFile(home.zshrc, "utf8")).toBe(ZSHRC_BEFORE);
    },
    INSTALL_TIMEOUT_MS,
  );

  test("an unknown flag is a usage error", async () => {
    const home = await freshHome();

    const result = await runInstall(home, { args: ["--bogus"] });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(
      "install.sh: unknown option '--bogus'\nUsage: ./install.sh [--no-modify-path]\n",
    );
    expect(await exists(home.binary)).toBe(false);
  });
});

describe("install.sh on an old Node", () => {
  test("fails with a clear message before building anything", async () => {
    const home = await freshHome();
    await writeExecutable(join(home.fakeBin, "node"), "#!/bin/sh\necho v22.1.0\n");

    const result = await runInstall(home);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("prx needs Node 24 or newer, found 22.1.0\n");
    expect(await exists(home.pnpmLog)).toBe(false);
    expect(await exists(home.binary)).toBe(false);
    expect(await readFile(home.zshrc, "utf8")).toBe(ZSHRC_BEFORE);
  });
});

describe("prx uninstall after install.sh", () => {
  test(
    "removes the binary and exactly the PATH block the installer wrote",
    async () => {
      const home = await freshHome();
      await runInstall(home);

      const result = await runNode([home.binary, "uninstall", "--yes"], isolatedHomeEnv(home.dir));

      expect(result.exitCode).toBe(0);
      expect(await exists(home.binary)).toBe(false);
      expect(await readFile(home.zshrc, "utf8")).toBe(ZSHRC_BEFORE);
    },
    INSTALL_TIMEOUT_MS,
  );
});
