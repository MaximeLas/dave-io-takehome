// `npm run index`: embeds every node's description and builds the vector index the search
// tool reads. Run once after the graph is seeded, and again after the model changes; the
// first run downloads the model (about 90 MB) into the library's cache. It writes to every
// node, so any argument other than --help is refused before it connects.
import { noArguments, reportFailure } from "../cli.js";
import { closeDriver } from "../graph/driver.js";
import { assertGraphReady } from "../graph/health.js";
import { EMBEDDING_MODEL_ID, INDEX_NAME } from "./model.js";
import { buildIndex } from "./vector-index.js";

noArguments(
  `
npm run index: embeds every node's description with the local model ${EMBEDDING_MODEL_ID}
(downloaded on first use, about 90 MB) and builds the vector index the search tool reads.
It writes a vector onto every node of the database at NEO4J_URI; run it once after seeding,
and again after re-seeding or changing the model.

Options:
  --help   print this help

Example:
  npm run index
`,
  "npm run index",
);

const started = Date.now();
try {
  const { nodes, distinctTexts } = await buildIndex();
  await assertGraphReady();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`ok  ${INDEX_NAME}: ${nodes} nodes from ${distinctTexts} distinct descriptions, ${EMBEDDING_MODEL_ID}, ${seconds}s`);
} catch (error) {
  reportFailure(error);
} finally {
  await closeDriver();
}
