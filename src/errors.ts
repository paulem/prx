export type ErrorCode =
  | "config_missing"
  | "config_invalid"
  | "proxy_not_live"
  | "unknown_preset"
  | "app_not_installed"
  | "app_already_running"
  | "endpoint_missing"
  | "dependency_missing"
  | "port_in_use"
  | "not_builtin"
  | "cancelled";

const PROXY_NOT_LIVE_EXIT_CODE = 1;
const USAGE_ERROR_EXIT_CODE = 2;
const APP_ALREADY_RUNNING_EXIT_CODE = 3;

const exitCodes: Record<ErrorCode, number> = {
  config_missing: USAGE_ERROR_EXIT_CODE,
  config_invalid: USAGE_ERROR_EXIT_CODE,
  proxy_not_live: PROXY_NOT_LIVE_EXIT_CODE,
  unknown_preset: USAGE_ERROR_EXIT_CODE,
  app_not_installed: USAGE_ERROR_EXIT_CODE,
  app_already_running: APP_ALREADY_RUNNING_EXIT_CODE,
  endpoint_missing: USAGE_ERROR_EXIT_CODE,
  dependency_missing: USAGE_ERROR_EXIT_CODE,
  port_in_use: USAGE_ERROR_EXIT_CODE,
  not_builtin: USAGE_ERROR_EXIT_CODE,
  cancelled: PROXY_NOT_LIVE_EXIT_CODE,
};

/**
 * A failure prx reports to the user itself, with a stable code for JSON mode and a fixed exit code.
 * The message joins the summary and the hint, for plain text and JSON; a decorated terminal
 * shows the hint on its own line instead
 */
export class PrxError extends Error {
  readonly code: ErrorCode;
  /** What went wrong, without the hint */
  readonly summary: string;
  /** The next command a person should run, when there is one */
  readonly hint: string | undefined;

  constructor(code: ErrorCode, summary: string, hint?: string) {
    super(hint === undefined ? summary : `${summary} ${hint}`);
    this.name = "PrxError";
    this.code = code;
    this.summary = summary;
    this.hint = hint;
  }

  get exitCode(): number {
    return exitCodes[this.code];
  }
}
