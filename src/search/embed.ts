// Turns text into vectors, locally, with the model Neo4j's own tooling defaults to
// (all-MiniLM-L6-v2: 384 numbers per text, mean pooling, unit length). The same function
// embeds the descriptions when the index is built and the search phrase when the agent
// searches, which is what makes the two comparable. The model is downloaded once into the
// library's cache and loaded once per process.
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

/** The embedding model; the index name and every run record carry it. */
export const EMBEDDING_MODEL = "onnx-community/all-MiniLM-L6-v2-ONNX";
/** The length of every vector the model produces. */
export const EMBEDDING_DIMENSIONS = 384;

let extractor: Promise<FeatureExtractionPipeline> | undefined;

/** Embeds each text as a unit-length vector of EMBEDDING_DIMENSIONS numbers, in input order. */
export async function embed(texts: string[]): Promise<number[][]> {
  // fp32 is the model as published; the quantized variants trade accuracy for size.
  extractor ??= pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "fp32" });
  const output = await (await extractor)(texts, { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
}
