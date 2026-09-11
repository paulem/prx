import { Writable } from "node:stream";
import type { PrxError } from "./errors.ts";
import { BAR_END, dim, red, renderBlock, symbol } from "./style.ts";
import type { SystemAdapter } from "./system.ts";

/** One piece of output written two ways; both end with a newline */
export interface View {
  plain: string;
  decorated: string;
}

/** Updates the spinner's message while work is in progress */
export type Progress = (message: string) => void;

/** Where a command's output goes: decorated for a person at a terminal, plain for pipes, JSON for wrappers */
export interface Reporter {
  /** A command's result on stdout: one of the views, or exactly one JSON object */
  result: (view: View, object: unknown) => void;
  /** Exactly one JSON object on stdout, for a command whose text goes to stderr */
  json: (object: unknown) => void;
  /** One step of a multi-step command: drawn inside clack's frame on a decorated stdout, the plain text otherwise */
  step: (plain: string, draw: (output: Writable) => void) => void;
  /** A progress line on stderr, for a person; silent in JSON mode */
  notice: (view: View) => void;
  error: (error: PrxError) => void;
  /** Runs the work behind a spinner when stderr is a decorated terminal, silently otherwise */
  wait: <T>(message: string, work: (progress: Progress) => Promise<T>) => Promise<T>;
}

export function createReporter(system: SystemAdapter, json: boolean): Reporter {
  const decoratedStdout = !json && system.decorates("stdout");
  const decoratedStderr = system.decorates("stderr");
  const stdout = writableOnto(system.writeStdout);

  function writeJson(object: unknown): void {
    system.writeStdout(`${JSON.stringify(object)}\n`);
  }

  return {
    result(view, object) {
      if (json) {
        writeJson(object);
      } else {
        system.writeStdout(decoratedStdout ? view.decorated : view.plain);
      }
    },
    json: writeJson,
    step(plain, draw) {
      if (decoratedStdout) {
        draw(stdout);
      } else if (plain !== "") {
        system.writeStdout(plain);
      }
    },
    notice(view) {
      if (!json) {
        system.writeStderr(decoratedStderr ? view.decorated : view.plain);
      }
    },
    error(error) {
      if (json) {
        const hint = error.hint === undefined ? {} : { hint: error.hint };
        writeJson({ error: { code: error.code, message: error.message, ...hint } });
      } else if (error.code === "cancelled" && decoratedStdout) {
        // The frame the wizard opened on stdout is closed on stdout, as clack's own cancel does
        system.writeStdout(`${BAR_END}  ${red(error.summary)}\n\n`);
      } else if (decoratedStderr) {
        system.writeStderr(decorateError(error));
      } else {
        system.writeStderr(`${error.message}\n`);
      }
    },
    async wait(message, work) {
      if (!decoratedStderr) {
        return work(() => {});
      }
      const spinner = system.spinner();
      spinner.start(message);
      try {
        return await work((update) => spinner.message(update));
      } finally {
        spinner.clear();
      }
    },
  };
}

function decorateError(error: PrxError): string {
  const lines =
    error.hint === undefined ? [red(error.summary)] : [red(error.summary), dim(error.hint)];
  return renderBlock({ mark: symbol("error"), lines });
}

function writableOnto(write: (text: string) => void): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      write(chunk.toString());
      callback();
    },
  });
}
