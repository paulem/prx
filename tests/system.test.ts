import { describe, expect, test } from "vitest";
import { createNodeSystemAdapter } from "../src/system.ts";

describe("the node system adapter", () => {
  test("never decorates when NO_COLOR is set", () => {
    const system = createNodeSystemAdapter({ NO_COLOR: "1" });

    expect(system.decorates("stdout")).toBe(false);
    expect(system.decorates("stderr")).toBe(false);
  });

  test("ignores an empty NO_COLOR and follows the stream", () => {
    const system = createNodeSystemAdapter({ NO_COLOR: "" });

    expect(system.decorates("stdout")).toBe(process.stdout.isTTY === true);
    expect(system.decorates("stderr")).toBe(process.stderr.isTTY === true);
  });
});
