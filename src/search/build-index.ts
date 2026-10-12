// `npm run index`: embeds every node's description and builds the vector index the search
// tool reads. Run once after the graph is seeded, and again after the model changes; the
// first run downloads the model (about 90 MB) into the library's cache.
import { closeDriver } from "../graph/driver.js";
import { EMBEDDING_MODEL } from "./embed.js";
import { assertIndexReady, buildIndex, INDEX_NAME } from "./vector-index.js";

const started = Date.now();
try {
  const { nodes, distinctTexts } = await buildIndex();
  await assertIndexReady();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`ok  ${INDEX_NAME}: ${nodes} nodes from ${distinctTexts} distinct descriptions, ${EMBEDDING_MODEL}, ${seconds}s`);
} finally {
  await closeDriver();
}
