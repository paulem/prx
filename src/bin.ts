import { runCli } from "./cli.ts";
import { createNodeSystemAdapter } from "./system.ts";

process.exitCode = await runCli(process.argv.slice(2), createNodeSystemAdapter());
