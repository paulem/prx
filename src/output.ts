import type { PrxError } from "./errors.ts";
import type { SystemAdapter } from "./system.ts";

/** Where a command's result goes: plain text for people, exactly one JSON object for wrappers */
export interface Reporter {
  result: (text: string, object: unknown) => void;
  error: (error: PrxError) => void;
}

export function createReporter(system: SystemAdapter, json: boolean): Reporter {
  return {
    result(text, object) {
      if (json) {
        system.writeStdout(`${JSON.stringify(object)}\n`);
      } else {
        system.writeStdout(text);
      }
    },
    error(error) {
      if (json) {
        system.writeStdout(
          `${JSON.stringify({ error: { code: error.code, message: error.message } })}\n`,
        );
      } else {
        system.writeStderr(`${error.message}\n`);
      }
    },
  };
}
