// The grader's own tests, run with `npm test` (Node's built-in runner, no model and no
// database). An oracle and a null: the answer key scored against itself must pass every
// question, and an empty answer must fail every question, the two with an empty expected
// set included. If either breaks, every eval score after it is meaningless.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { loadQuestions } from "./questions.js";
import { applyOverlay, diagnostics, loadAnswerKey, loadKeyOverlay, scoreAnswer } from "./score.js";
import type { RunRecord } from "../src/agent/record.js";

const key = await loadAnswerKey();
const questions = await loadQuestions();
const text = (id: string) => questions.find((q) => q.id === id)!.text;

test("the key lists every question, and every question is in the key", () => {
  assert.deepEqual(questions.map((q) => q.id).sort(), Object.keys(key).sort());
  assert.equal(questions.length, 30);
});

test("oracle: the key scored against itself passes every question", () => {
  for (const q of questions) {
    const score = scoreAnswer({ answer: "the expected answer", ids: key[q.id]! }, key[q.id]!, q.text);
    assert.ok(score.pass, `${q.id} should pass`);
    assert.equal(score.recall, 1);
    assert.equal(score.precision, 1);
  }
});

test("null: an empty answer fails every question, even when nothing is expected", () => {
  for (const q of questions) {
    const score = scoreAnswer({ answer: "", ids: [] }, key[q.id]!, q.text);
    assert.ok(!score.pass, `${q.id} should fail`);
    assert.ok(score.empty);
  }
});

test("blank prose fails even with the right ids: the pass needs an answer, not just a list", () => {
  const score = scoreAnswer({ answer: "", ids: key["dlq-for-prod-2"]! }, key["dlq-for-prod-2"]!, text("dlq-for-prod-2"));
  assert.ok(!score.pass);
  assert.ok(score.empty);
  assert.equal(score.recall, 1);
});

test("a duplicated id counts once", () => {
  const expected = key["who-can-reach-prod-bucket-1"]!;
  const score = scoreAnswer({ answer: "x", ids: [...expected, expected[0]!] }, expected, text("who-can-reach-prod-bucket-1"));
  assert.ok(score.pass);
  assert.equal(score.asserted, 2);
  assert.equal(score.precision, 1);
});

test("an explicit 'none' passes a question whose expected set is empty", () => {
  const score = scoreAnswer({ answer: "No dev instance reaches production storage.", ids: [] }, [], text("dev-reaching-prod-storage"));
  assert.ok(score.pass);
  assert.equal(score.expected, 0);
});

test("ids the question names are neutral, whichever way the key went", () => {
  // The key leaves the question's own queue out; asserting it must not count as extra.
  const withSubject = scoreAnswer(
    { answer: "x", ids: ["aws:sqs:queue-commerce-prod-14", "aws:sqs:queue-commerce-prod-2"] },
    key["dlq-for-prod-2"]!,
    text("dlq-for-prod-2"),
  );
  assert.ok(withSubject.pass);
  // The key includes the starting instance; leaving it out must not count as missing.
  const withoutSubject = scoreAnswer(
    { answer: "x", ids: key["path-compute-to-s3"]!.filter((id) => id !== "aws:ec2:i-ecomm-prod-01") },
    key["path-compute-to-s3"]!,
    text("path-compute-to-s3"),
  );
  assert.ok(withoutSubject.pass);
  // Whole-word matching: prod-1 in the question must not neutralise prod-14.
  const nested = scoreAnswer({ answer: "x", ids: [] }, key["which-dlq-serves-the-purchase-queue"]!, text("which-dlq-serves-the-purchase-queue"));
  assert.deepEqual(nested.missing, ["aws:sqs:queue-commerce-prod-13"]);
});

test("a wrong member fails, with recall and precision saying which way", () => {
  const expected = key["who-can-reach-prod-bucket-1"]!; // prod-01 and prod-09
  const padded = scoreAnswer({ answer: "x", ids: [...expected, "aws:ec2:i-ecomm-prod-02"] }, expected, text("who-can-reach-prod-bucket-1"));
  assert.ok(!padded.pass);
  assert.equal(padded.recall, 1);
  assert.equal(padded.precision, 2 / 3);
  assert.deepEqual(padded.extra, ["aws:ec2:i-ecomm-prod-02"]);

  const short = scoreAnswer({ answer: "x", ids: [expected[0]!] }, expected, text("who-can-reach-prod-bucket-1"));
  assert.ok(!short.pass);
  assert.equal(short.recall, 0.5);
  assert.equal(short.precision, 1);
});

test("an empty overlay leaves the key as it is", () => {
  assert.deepEqual(applyOverlay(key, {}), key);
});

test("an overlay entry replaces that question's expected ids and nothing else", () => {
  const ids = ["aws:sqs:queue-commerce-prod-1"];
  const amended = applyOverlay(key, { "dlq-for-prod-2": { expected_resource_ids: ids, reason: "a test", audit: "eval/key-audit.md#dlq-for-prod-2" } });
  assert.deepEqual(amended["dlq-for-prod-2"], ids);
  for (const id of Object.keys(key).filter((id) => id !== "dlq-for-prod-2")) assert.deepEqual(amended[id], key[id], id);
  assert.notDeepEqual(key["dlq-for-prod-2"], ids, "the key itself is not changed");
  assert.throws(() => applyOverlay(key, { "no-such-question": { expected_resource_ids: [], reason: "", audit: "" } }), /no-such-question/);
});

test("the committed overlay: an absent file reads as empty, and each entry names a question, a reason and its audit entry", async () => {
  assert.deepEqual(await loadKeyOverlay(new URL("./no-such-overlay.json", import.meta.url)), {});
  const overlay = await loadKeyOverlay();
  const audit = await readFile(new URL("./key-audit.md", import.meta.url), "utf8");
  for (const [id, entry] of Object.entries(overlay)) {
    assert.ok(id in key, id);
    assert.ok(entry.reason.length > 0, `${id} has a reason`);
    assert.equal(entry.audit, `eval/key-audit.md#${id}`);
    // Its entry in the audit, up to the next entry, ends in a verdict that does not agree with the key.
    const section = audit.split(/^### /m).find((s) => s.startsWith(`\`${id}\``));
    assert.ok(section, `${id} has an entry in the audit`);
    assert.match(section, /\*\*Verdict: (disagrees|ambiguous)/, `${id}'s audit verdict`);
  }
  // The amended key scored against itself passes every question, as the key does.
  const amended = applyOverlay(key, overlay);
  for (const q of questions) assert.ok(scoreAnswer({ answer: "x", ids: amended[q.id]! }, amended[q.id]!, q.text).pass, q.id);
});

test("diagnostics count Cypher errors and cut results off the record", () => {
  const record = {
    durationMs: 1200,
    costUsd: 0.01,
    stopReasons: ["tool_use", "tool_use", "end_turn"],
    toolCalls: [
      { name: "run_cypher", input: {}, output: "3 rows\ncolumns: id\na\nb\nc", isError: false },
      { name: "run_cypher", input: {}, output: "Cypher error: Invalid input", isError: true },
      { name: "run_cypher", input: {}, output: "100 of 251 rows shown. Narrow the query.", isError: false },
    ],
  } as unknown as RunRecord;
  assert.deepEqual(diagnostics(record), {
    toolCalls: 3,
    cypherErrors: 1,
    cutResults: 1,
    durationMs: 1200,
    costUsd: 0.01,
    stopReason: "end_turn",
  });
});
