// The command-line convention the developer commands share (`npm run check`, `index`, `ask`,
// `eval`, `simulate-gate`): `--help` prints what the command does, its options with their defaults and an
// example, and exits 0; a usage error is one line naming the fix, printed before any token is
// spent or any data is written; a failure is one line, never a stack trace. Kept in one place
// so the commands cannot drift apart. `--help` is answered before settings are read, so it
// works on a fresh clone with no `.env`.

/** One labelled line of a report block (`model       claude-haiku-5-5`), so every block aligns the same way. */
export const field = (label: string, value: string): string => `${label.padEnd(12)}${value}`;

/** A timestamp in the machine's local time, to the second, with its offset from UTC (`2026-10-12 21:32:39 UTC+03:00`). */
export function localTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const zone = `UTC${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`
  );
}

/** The exit code of a usage error, the same for every command (the eval's CI contract uses it too). */
export const USAGE_EXIT = 3;

/** Prints the help and exits 0 when the arguments ask for it. */
export function answerHelp(help: string, args: string[] = process.argv.slice(2)): void {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help.trim());
    process.exit(0);
  }
}

/** Prints a one-line usage error, pointing at the command's --help when one is named, and exits before the command does anything. */
export function usageError(message: string, command?: string): never {
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  console.error(command ? `${sentence} See ${command} -- --help.` : sentence);
  process.exit(USAGE_EXIT);
}

/** Node's parseArgs error as one short line: its unknown-option message carries a long hint about positionals, cut here. */
export function argsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^Unknown option '[^']+'/.exec(message)?.[0] ?? message.split("\n")[0]!;
}

/** For a command that takes no arguments besides --help: answers --help, refuses anything else. */
export function noArguments(help: string, command: string): void {
  answerHelp(help);
  const args = process.argv.slice(2);
  if (args.length > 0) usageError(`${command} takes no arguments (got ${args.join(" ")})`, command);
}

/** Prints a failure as one line (the error's first line) and sets the exit code, leaving cleanup to the caller's finally. */
export function reportFailure(error: unknown, prefix = "FAIL  "): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${prefix}${message.split("\n")[0]}`);
  process.exitCode = 1;
}
