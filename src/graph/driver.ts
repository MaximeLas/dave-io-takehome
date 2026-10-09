// One Neo4j driver per process. A driver is a connection pool: cheap to hold,
// expensive to create, so it is built once, lazily, and closed when the process ends.
import neo4j, { type Driver } from "neo4j-driver";

import { requireEnv } from "../env.js";

let driver: Driver | undefined;

/** The process-wide driver, created on first use. */
export function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      requireEnv("NEO4J_URI"),
      neo4j.auth.basic(requireEnv("NEO4J_USER"), requireEnv("NEO4J_PASSWORD")),
      // Neo4j integers are 64-bit and arrive as a special Integer type by default.
      // Nothing in this graph needs more than 53 bits, so plain JS numbers are simpler.
      { disableLosslessIntegers: true },
    );
  }
  return driver;
}

/** Closes the driver so a script's process can exit; the next getDriver() creates a new one. */
export async function closeDriver(): Promise<void> {
  await driver?.close();
  driver = undefined;
}
