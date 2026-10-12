// Turns text into vectors, locally, with the model in model.ts (384 numbers per text, mean
// pooling, unit length, as the original sentence-transformers model is configured). The same
// function embeds the descriptions when the index is built and the search phrase when the
// agent searches, which is what makes the two comparable. The model is downloaded once into
// the library's cache and loaded once per process.
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

import { EMBEDDING_MODEL, EMBEDDING_REVISION } from "./model.js";

let extractor: Promise<FeatureExtractionPipeline> | undefined;

/** Embeds each text as a unit-length vector of EMBEDDING_DIMENSIONS numbers, in input order. */
export async function embed(texts: string[]): Promise<number[][]> {
  // fp32 is the model as published; the quantized variants trade accuracy for size.
  extractor ??= pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "fp32", revision: EMBEDDING_REVISION });
  const output = await (await extractor)(texts, { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
}
