import { test } from "node:test";
import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { parseArgs } from "../lib/cli.js";

test("parseArgs: defaults", () => {
  deepStrictEqual(parseArgs([]), {
    input: undefined,
    output: undefined,
    verbose: false,
    split: false,
    mode: "html",
    help: false,
  });
});

test("parseArgs: --probe sets mode to probe", () => {
  strictEqual(parseArgs(["--probe"]).mode, "probe");
});

test("parseArgs: --inject sets mode to inject", () => {
  strictEqual(parseArgs(["--inject"]).mode, "inject");
});

test("parseArgs: --inject-dry-run sets mode to inject-dry-run", () => {
  strictEqual(parseArgs(["--inject-dry-run"]).mode, "inject-dry-run");
});

test("parseArgs: --probe + --inject is a conflict", () => {
  throws(() => parseArgs(["--probe", "--inject"]), /mutually exclusive/);
});

test("parseArgs: --split + --inject is a conflict", () => {
  throws(() => parseArgs(["--split", "--inject"]), /split.*only applies/i);
});

test("parseArgs: --output combines with --inject", () => {
  const args = parseArgs(["--inject", "--output", "x.js"]);
  strictEqual(args.mode, "inject");
  strictEqual(args.output, "x.js");
});

test("parseArgs: --help sets help flag without exiting", () => {
  const args = parseArgs(["--help"]);
  strictEqual(args.help, true);
});

test("parseArgs: -h sets help flag without exiting", () => {
  const args = parseArgs(["-h"]);
  strictEqual(args.help, true);
});

test("parseArgs: --inject + --inject (duplicate) is a conflict", () => {
  throws(() => parseArgs(["--inject", "--inject"]), /mutually exclusive/);
});

test("parseArgs: --inject + --split is also a conflict (reverse order)", () => {
  throws(() => parseArgs(["--inject", "--split"]), /split.*only applies/i);
});

test("parseArgs: --unwind sets mode to unwind", () => {
  strictEqual(parseArgs(["--unwind"]).mode, "unwind");
});

test("parseArgs: --unwind-dry-run sets mode to unwind-dry-run", () => {
  strictEqual(parseArgs(["--unwind-dry-run"]).mode, "unwind-dry-run");
});

test("parseArgs: --unwind + --inject is a conflict", () => {
  throws(() => parseArgs(["--unwind", "--inject"]), /mutually exclusive/);
});

test("parseArgs: --split + --unwind is a conflict", () => {
  throws(() => parseArgs(["--split", "--unwind"]), /split.*only applies/i);
});
