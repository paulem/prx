import { S_BAR_END, S_ERROR, S_INFO, S_STEP_SUBMIT, S_SUCCESS, S_WARN } from "@clack/prompts";
import { pathToFileURL } from "node:url";
import { styleText } from "node:util";

// Nothing here checks the stream: the reporter decides whether a stream is decorated, so every
// helper always emits its codes

type Format = Parameters<typeof styleText>[0];

function paint(format: Format, text: string): string {
  return styleText(format, text, { validateStream: false });
}

export function bold(text: string): string {
  return paint("bold", text);
}

export function dim(text: string): string {
  return paint("dim", text);
}

export function green(text: string): string {
  return paint("green", text);
}

export function red(text: string): string {
  return paint("red", text);
}

export function yellow(text: string): string {
  return paint("yellow", text);
}

export function cyan(text: string): string {
  return paint("cyan", text);
}

/** What a line is about: a settled state, a completed step, a concern, a failure, or a mere fact */
export type Tone = "success" | "step" | "warn" | "error" | "muted";

const GLYPHS: Record<Tone, string> = {
  success: S_SUCCESS,
  step: S_STEP_SUBMIT,
  warn: S_WARN,
  error: S_ERROR,
  muted: S_INFO,
};

const COLORS: Record<Tone, (text: string) => string> = {
  success: green,
  step: green,
  warn: yellow,
  error: red,
  muted: dim,
};

export function symbol(tone: Tone): string {
  return COLORS[tone](GLYPHS[tone]);
}

/** The symbol as a table cell, so a row can carry its own mark */
export function symbolCell(tone: Tone): Cell {
  return { text: GLYPHS[tone], style: COLORS[tone] };
}

/** The closing bar clack draws under a cancelled interaction */
export const BAR_END = dim(S_BAR_END);

/** One symbol-led paragraph: the mark leads the first line, the rest hang under it */
export interface Block {
  mark: string;
  lines: string[];
}

export function renderBlock({ mark, lines }: Block): string {
  const [first = "", ...rest] = lines;
  return [`${mark}  ${first}`, ...rest.map((line) => `   ${line}`)]
    .map((line) => `${line}\n`)
    .join("");
}

const OSC = "\u001b]";
const ST = "\u001b\\";

/** A terminal hyperlink, shown as plain text where the terminal does not support OSC 8 */
export function link(text: string, url: string): string {
  return `${OSC}8;;${url}${ST}${text}${OSC}8;;${ST}`;
}

/** A path shortened with ~ and linked to the file, so a click opens it */
export function pathLink(homeDir: string, path: string): string {
  return link(tildePath(homeDir, path), pathToFileURL(path).href);
}

export function tildePath(homeDir: string, path: string): string {
  if (path === homeDir) {
    return "~";
  }
  return path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path;
}

/** A table cell: padding is measured on the text, the style is applied afterwards */
export interface Cell {
  text: string;
  style?: (text: string) => string;
  /** Runs to the end of the row and leaves its column's width alone; only for a row's last cell */
  span?: boolean;
}

const COLUMN_GAP = "  ";

/** Aligns rows into columns; the last cell of each row is never padded */
export function table(rows: Cell[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      if (cell.span !== true) {
        widths[index] = Math.max(widths[index] ?? 0, cell.text.length);
      }
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => {
        const padded = index === row.length - 1 ? cell.text : cell.text.padEnd(widths[index] ?? 0);
        return cell.style === undefined ? padded : cell.style(padded);
      })
      .join(COLUMN_GAP)
      .trimEnd(),
  );
}
