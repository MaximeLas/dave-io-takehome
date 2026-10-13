// The grader's own tests, run with `npm test` (Node's built-in runner, no model and no
// database). An oracle and a null: the answer key scored against itself must pass every
// question, and an empty answer must fail every question, the two with an empty expected
// set included. If either breaks, every eval score after it is meaningless.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { loadQuestions } from "./questions.js";
import { applyOverlay, checkAnswer, diagnostics, loadAnswerKey, loadKeyOverlay, scoreAnswer } from "./score.js";
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

test("diagnostics count search calls, Cypher errors and cut results off the record", () => {
  const record = {
    durationMs: 1200,
    costUsd: 0.01,
    stopReasons: ["tool_use", "tool_use", "tool_use", "end_turn"],
    toolCalls: [
      { name: "search_descriptions", input: { query: "payment data" }, output: "10 of 79 descriptions shown", isError: false },
      { name: "run_cypher", input: {}, output: "3 rows\ncolumns: id\na\nb\nc", isError: false },
      { name: "run_cypher", input: {}, output: "Cypher error: Invalid input", isError: true },
      { name: "run_cypher", input: {}, output: "100 of 251 rows shown. Narrow the query.", isError: false },
    ],
  } as unknown as RunRecord;
  assert.deepEqual(diagnostics(record), {
    toolCalls: 4,
    searchCalls: 1,
    cypherErrors: 1,
    cutResults: 1,
    durationMs: 1200,
    costUsd: 0.01,
    stopReason: "end_turn",
  });
});

// The answer against the evidence and against itself, on hand-made records shaped like the tools' output.
const names = new Map([
  ["aws:sqs:queue-commerce-prod-1", "queue-commerce-prod-1"],
  ["aws:sqs:queue-commerce-prod-13", "queue-commerce-prod-13"],
  ["aws:sqs:queue-commerce-prod-14", "queue-commerce-prod-14"],
  ["aws:sqs:queue-commerce-prod-15", "queue-commerce-prod-15"],
  ["aws:sqs:queue-commerce-prod-16", "queue-commerce-prod-16"],
  ["aws:rds:rds-commerce-prod-14", "rds-commerce-prod-14"],
  ["aws:s3:bucket-commerce-prod-1", "bucket-commerce-prod-1"],
  ["aws:s3-policy:bucket-commerce-prod-1", "bucket-commerce-prod-1-policy"],
  ["datadog:monitor:commerce-5", "commerce-prod-monitor-5"],
]);
const cypher = (output: string) => ({ name: "run_cypher", input: { query: "MATCH ..." }, output, isError: false });
const QUEUES = [
  "4 rows",
  "columns: id | name",
  "aws:sqs:queue-commerce-prod-13 | queue-commerce-prod-13",
  "aws:sqs:queue-commerce-prod-14 | queue-commerce-prod-14",
  "aws:sqs:queue-commerce-prod-15 | queue-commerce-prod-15",
  "aws:sqs:queue-commerce-prod-16 | queue-commerce-prod-16",
].join("\n");
const answer = (ids: string[], prose: string, outputs: string[] = [QUEUES]) => ({ ids, answer: prose, toolCalls: outputs.map(cypher) });
const ASK = "Which queues are dead-letter queues?";

test("grounded: an id a tool printed is grounded, an id never printed is not, whether or not the answer passes", () => {
  assert.deepEqual(checkAnswer(answer(["aws:sqs:queue-commerce-prod-13", "aws:sqs:queue-commerce-prod-14"], "x"), names, ASK).ungrounded, []);
  // The same pattern, one number further: in no output of the run, so built, not read.
  const built = checkAnswer(answer(["aws:sqs:queue-commerce-prod-13", "aws:sqs:queue-commerce-prod-17"], "x"), names, ASK);
  assert.deepEqual(built.ungrounded, ["aws:sqs:queue-commerce-prod-17"]);
  // A prefix of a printed id is not that id.
  assert.deepEqual(checkAnswer(answer(["aws:sqs:queue-commerce-prod-1"], "x"), names, ASK).ungrounded, ["aws:sqs:queue-commerce-prod-1"]);
  // A name read without its id: the id's prefix was assumed, so the id is flagged even though it is right.
  const nameOnly = "1 row\ncolumns: name\nbucket-commerce-prod-1";
  assert.deepEqual(checkAnswer(answer(["aws:s3:bucket-commerce-prod-1"], "x", [nameOnly]), names, ASK).ungrounded, ["aws:s3:bucket-commerce-prod-1"]);
});

test("grounded: both tools count, a label before the id does not hide it, and a query's own text is not evidence", () => {
  const search = {
    name: "search_descriptions",
    input: { query: "failed messages" },
    output: "1 of 79 descriptions shown, best first, covering 2 resources.\n0.61 | Dead-letter queue. | aws:sqs:queue-commerce-prod-13, aws:sqs:queue-commerce-prod-14",
    isError: false,
  };
  assert.deepEqual(checkAnswer({ ids: ["aws:sqs:queue-commerce-prod-14"], answer: "x", toolCalls: [search] }, names, ASK).ungrounded, []);
  const labelled = '1 row\ncolumns: chain\n["Entity:aws:sqs:queue-commerce-prod-13"]';
  assert.deepEqual(checkAnswer(answer(["aws:sqs:queue-commerce-prod-13"], "x", [labelled]), names, ASK).ungrounded, []);
  const asked = { name: "run_cypher", input: { query: "MATCH (q {id: 'aws:sqs:queue-commerce-prod-15'}) RETURN count(q)" }, output: "1 row\ncolumns: count(q)\n1", isError: false };
  assert.deepEqual(checkAnswer({ ids: ["aws:sqs:queue-commerce-prod-15"], answer: "x", toolCalls: [asked] }, names, ASK).ungrounded, ["aws:sqs:queue-commerce-prod-15"]);
});

test("grounded: an error that quotes the failing query, or another tool echoing the model, is not evidence", () => {
  const failed = {
    name: "run_cypher",
    input: { query: "MATCH (q {id:'aws:sqs:queue-commerce-prod-15'}) RETURN q UNION ALL MATCH (t)" },
    output: `Cypher error: All sub queries in an UNION must have the same return column names (line 1, column 50)\n"MATCH (q {id:'aws:sqs:queue-commerce-prod-15'}) RETURN q UNION ALL MATCH (t)"`,
    isError: true,
  };
  const echo = { name: "read_file", input: { path: "notes" }, output: "aws:sqs:queue-commerce-prod-15", isError: false };
  for (const call of [failed, echo]) {
    assert.deepEqual(checkAnswer({ ids: ["aws:sqs:queue-commerce-prod-15"], answer: "x", toolCalls: [call] }, names, ASK).ungrounded, ["aws:sqs:queue-commerce-prod-15"], call.name);
  }
});

test("grounded and prose: the ids the question names count neither way, as in the pass", () => {
  const c = checkAnswer(answer(["aws:sqs:queue-commerce-prod-1", "aws:sqs:queue-commerce-prod-13"], "queue-commerce-prod-13"), names, "Where do failed messages from queue-commerce-prod-1 go?");
  assert.deepEqual(c, { ungrounded: [], proseNamed: 1 });
});

test("prose: the share of asserted ids the prose names, by id or by the graph's name; 1 when nothing is asserted", () => {
  const ids = ["aws:sqs:queue-commerce-prod-13", "aws:sqs:queue-commerce-prod-14", "aws:s3:bucket-commerce-prod-1", "datadog:monitor:commerce-5"];
  const prose = "aws:sqs:queue-commerce-prod-13: one; queue-commerce-prod-14, bucket-commerce-prod-1 and commerce-prod-monitor-5.";
  assert.equal(checkAnswer(answer(ids, prose), names, ASK).proseNamed, 1);
  assert.equal(checkAnswer(answer(ids, "Four resources match."), names, ASK).proseNamed, 0);
  // A monitor's id ends in `commerce-5`, its name is `commerce-prod-monitor-5`; a bucket is not named by its policy.
  assert.equal(checkAnswer(answer(["datadog:monitor:commerce-5"], "commerce-5 alerts."), names, ASK).proseNamed, 0);
  assert.equal(checkAnswer(answer(["aws:s3:bucket-commerce-prod-1"], "bucket-commerce-prod-1-policy, aws:s3-policy:bucket-commerce-prod-1."), names, ASK).proseNamed, 0);
  assert.equal(checkAnswer(answer(["aws:sqs:queue-commerce-prod-1"], "queue-commerce-prod-13"), names, ASK).proseNamed, 0);
  assert.equal(checkAnswer(answer(ids, "queue-commerce-prod-13 and bucket-commerce-prod-1."), names, ASK).proseNamed, 0.5);
  assert.equal(checkAnswer(answer([], "No queue matches."), names, ASK).proseNamed, 1);
});

test("prose: a family named once in full and abbreviated after counts, in a list or a range; without a full sibling it does not", () => {
  const four = ["aws:sqs:queue-commerce-prod-13", "aws:sqs:queue-commerce-prod-14", "aws:sqs:queue-commerce-prod-15", "aws:sqs:queue-commerce-prod-16"];
  const abbreviated = [
    "queue-commerce-prod-13, -14, -15 and -16.",
    "queue-commerce-prod-13, prod-14, prod-15 and prod-16.",
    "queue-commerce-prod-13 to -16.",
    "queue-commerce-prod-13 through prod-16.",
    "queue-commerce-prod-13–16.",
    "aws:sqs:queue-commerce-prod-13, prod-14, prod-15 and prod-16.",
    "queues (queue-commerce-prod-13, 14, 15 and 16).",
    "queue-commerce-prod-12 is watched; the others are prod-13, 14, 15 and 16.",
    "aws:sqs:queue-commerce-prod-13 through aws:sqs:queue-commerce-prod-16.",
    "queue-commerce-prod-13 and -14 (dead-letter), -15 and -16 (unused).",
    "`queue-commerce-prod-13`, `-14`, `-15` and `-16`.",
  ];
  for (const prose of abbreviated) assert.equal(checkAnswer(answer(four, prose), names, ASK).proseNamed, 1, prose);
  assert.equal(checkAnswer(answer(four, "The dead-letter queues are prod-13 to prod-16."), names, ASK).proseNamed, 0);
  // A family abbreviated by its id rather than its name.
  const monitors = new Map([...names, ["datadog:monitor:commerce-6", "commerce-prod-monitor-6"]]);
  assert.equal(checkAnswer(answer(["datadog:monitor:commerce-5", "datadog:monitor:commerce-6"], "datadog:monitor:commerce-5, -6."), monitors, ASK).proseNamed, 1);
  // Another family's member does not name this one.
  assert.equal(checkAnswer(answer(["aws:sqs:queue-commerce-prod-14"], "queue-commerce-prod-13 and rds-commerce-prod-14."), names, ASK).proseNamed, 0);
  // A range or a list counts only in a run that starts at the family: not another family's, not a loose one.
  const dev = new Map([...names, ["aws:sqs:queue-commerce-dev-2", "queue-commerce-dev-2"], ["aws:sqs:queue-commerce-dev-1", "queue-commerce-dev-1"]]);
  const loose = [
    "queue-commerce-dev-1 is reached; prod queues 1 to 16 are too.",
    "queue-commerce-dev-1 and queue-commerce-prod-1 to prod-16.",
    "queue-commerce-dev-1, then 1 to 6 hops.",
    "queue-commerce-dev-1, -5 and prod-2.",
  ];
  for (const prose of loose) assert.equal(checkAnswer(answer(["aws:sqs:queue-commerce-dev-2"], prose), dev, ASK).proseNamed, 0, prose);
  assert.equal(checkAnswer(answer(["aws:sqs:queue-commerce-dev-2"], "queue-commerce-dev-1 to dev-4."), dev, ASK).proseNamed, 1);
  // A run may start at the id and end at the name.
  assert.equal(checkAnswer(answer(["aws:sqs:queue-commerce-dev-2"], "aws:sqs:queue-commerce-dev-1 through queue-commerce-dev-4."), dev, ASK).proseNamed, 1);
});

test("the key's own ids, printed by a tool and listed in the prose, are grounded and named on every question", () => {
  for (const q of questions) {
    const ids = key[q.id]!;
    const c = checkAnswer(answer(ids, ids.join(", "), [`${ids.length} rows\ncolumns: id\n${ids.join("\n")}`]), new Map(), q.text);
    assert.deepEqual(c, { ungrounded: [], proseNamed: 1 }, q.id);
  }
});
