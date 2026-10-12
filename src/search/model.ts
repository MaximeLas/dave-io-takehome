// What identifies the description vectors: the embedding model, pinned to one revision of
// its repository, and where the vectors live. Kept apart from the code that runs the model,
// so the readiness check and the query tool can name the index without loading it.

/** The embedding model: all-MiniLM-L6-v2, the local model Neo4j's own tooling defaults to. */
export const EMBEDDING_MODEL = "onnx-community/all-MiniLM-L6-v2-ONNX";
/** The commit of the model's repository, so the vectors cannot change under the same name. */
export const EMBEDDING_REVISION = "aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f";
/** The model and its revision, as run records state it. */
export const EMBEDDING_MODEL_ID = `${EMBEDDING_MODEL}@${EMBEDDING_REVISION.slice(0, 7)}`;
/** The length of every vector the model produces. */
export const EMBEDDING_DIMENSIONS = 384;

/** The node property that holds each node's description vector. */
export const EMBEDDING_PROPERTY = "embedding";
/** The vector index's name, derived from the model and its revision, so a stale index reads as missing. */
export const INDEX_NAME = `descriptions_${EMBEDDING_MODEL_ID.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
