// Every resource's name by its id, read from the graph once per eval run. The eval's prose check
// knows a resource by its id or by its name, and for 32 resources the name is not the id's last
// segment (docs/facts.md F20), so the name comes from the graph, not from the id.
import { getDriver } from "./driver.js";

/** Each resource's `name` by its `id`, for every node of the graph. */
export async function loadResourceNames(): Promise<Map<string, string>> {
  const { records } = await getDriver().executeQuery("MATCH (n:Entity) RETURN n.id AS id, n.name AS name");
  return new Map(records.map((r) => [r.get("id") as string, r.get("name") as string]));
}
