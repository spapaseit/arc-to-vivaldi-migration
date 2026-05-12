export type CliMode =
  | "html"
  | "probe"
  | "inject"
  | "inject-dry-run"
  | "unwind"
  | "unwind-dry-run";

export interface CliArgs {
  readonly input: string | undefined;
  readonly output: string | undefined;
  readonly verbose: boolean;
  readonly split: boolean;
  readonly mode: CliMode;
  readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let input: string | undefined;
  let output: string | undefined;
  let verbose = false;
  let split = false;
  let mode: CliMode = "html";
  let help = false;

  const setMode = (next: CliMode): void => {
    if (mode !== "html") {
      throw new Error(
        `--probe, --inject, --inject-dry-run, --unwind and --unwind-dry-run are mutually exclusive`,
      );
    }
    mode = next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--input requires a value");
      input = next;
      i++;
    } else if (arg === "--output") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--output requires a value");
      output = next;
      i++;
    } else if (arg === "--split") {
      split = true;
    } else if (arg === "--probe") {
      setMode("probe");
    } else if (arg === "--inject") {
      setMode("inject");
    } else if (arg === "--inject-dry-run") {
      setMode("inject-dry-run");
    } else if (arg === "--unwind") {
      setMode("unwind");
    } else if (arg === "--unwind-dry-run") {
      setMode("unwind-dry-run");
    } else if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
      break;
    } else if (arg !== undefined) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (split && mode !== "html") {
    throw new Error("--split only applies to HTML output, not JS payload modes");
  }

  return { input, output, verbose, split, mode, help };
}
