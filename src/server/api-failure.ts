// A failed model call as the eval page shows it: one line with the API's status and its own
// message, so a spent quota or an overloaded API reads as what it is, never as a stack or a hang.

/**
 * A model call's failure in one line. Takes the error, or the line the harness recorded for a
 * question run that threw ("<ErrorName>[ <status>]: <message>", eval/harness.ts). Through
 * LangChain, an API refusal arrives as a plain Error whose message is the status and the JSON
 * body ("400 {...}"), so the status and the body's message are read from the text.
 */
export function apiFailure(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  let status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  if (!(error instanceof Error)) {
    const prefixed = /^\w+(?: (\d{3}))?: ([\s\S]*)$/.exec(message);
    if (prefixed) [status, message] = [prefixed[1] ? Number(prefixed[1]) : undefined, prefixed[2]!];
  }
  const leading = /^(\d{3}) [{[]/.exec(message);
  if (typeof status !== "number" && leading) status = Number(leading[1]);
  const body = /"message"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  const text = (body ?? message).split("\n", 1)[0]!.slice(0, 300);
  return typeof status === "number" ? `the model API answered ${status}: ${text}` : text;
}
