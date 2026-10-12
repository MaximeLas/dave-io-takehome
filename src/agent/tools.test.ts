// The search tool's reply is all the model sees of a search, so its shape is pinned here
// without a model or a database: the count first, one line per description with every id
// that carries it, and a last line that says whether more were left out and how close they came.
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatSearch } from "./tools.js";

const hits = [
  { score: 0.81, description: "SQS queue for fulfillment-style work.", ids: ["q-5", "q-6"] },
  { score: 0.77, description: "Worker host near fulfillment jobs.", ids: ["i-4"] },
];

test("a cut search says how many were left out and the best score among them", () => {
  const text = formatSearch({ hits, totalDescriptions: 79, nextScore: 0.76 });
  assert.equal(
    text,
    [
      "2 of 79 descriptions shown, best first, covering 3 resources.",
      "0.81 | SQS queue for fulfillment-style work. | q-5, q-6",
      "0.77 | Worker host near fulfillment jobs. | i-4",
      "77 more not shown; the best of them scores 0.76. Search again with a larger limit if the last ones shown are still relevant.",
    ].join("\n"),
  );
});

test("a search that shows everything says so", () => {
  const text = formatSearch({ hits, totalDescriptions: 2, nextScore: null });
  assert.match(text, /Every description is shown\.$/);
});
