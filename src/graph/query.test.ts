// Every node carries a 384-number description vector, so the query tool's output must
// summarise one wherever it appears, most often inside `properties(n)`, and leave every
// other value as it was. Pinned here without a database.
import assert from "node:assert/strict";
import { test } from "node:test";

import { plain, VECTOR_MIN_LENGTH } from "./query.js";

const vector = Array.from({ length: 384 }, (_, i) => i / 384);

test("a vector inside a node's properties prints as its length", () => {
  const properties = { id: "aws:sqs:queue-commerce-prod-1", name: "queue-commerce-prod-1", embedding: vector };
  assert.deepEqual(plain(properties), {
    id: "aws:sqs:queue-commerce-prod-1",
    name: "queue-commerce-prod-1",
    embedding: "<vector, 384 numbers>",
  });
});

test("a returned vector column prints as its length", () => {
  assert.equal(plain(vector), "<vector, 384 numbers>");
});

test("short lists of numbers and lists of text are left as they are", () => {
  const short = Array.from({ length: VECTOR_MIN_LENGTH - 1 }, (_, i) => i);
  assert.deepEqual(plain(short), short);
  const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
  assert.deepEqual(plain(ids), ids);
});
