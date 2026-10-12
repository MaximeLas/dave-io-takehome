# How the agent reads a business area (2026-10-12)

**Pattern.** Five questions ask about a business area. Across the eleven full runs of the shipped prompt (`1f77e706`), four failed every time and one passed twice:
- "Which prod resources are related to checkout or order flow?" (0 of 11);
- "Which resources serve storefront or customer-facing traffic?" (0 of 11);
- "What should I inspect if fulfillment jobs are backing up?" (0 of 11);
- "The instances described as order-flow — which data resources do they actually have access to?" (0 of 11; its key counts queues as data, see [the conventions experiment](2026-10-11-conventions.md));
- "Which resources are involved in fulfillment?" (2 of 11).

The traces show the agent finding the resources and then dropping them. It modelled an area as a lane: the compute described as the area, confirmed by its scaling group, target group and pipeline, plus whatever that compute is wired to. So checkout pulled in the dead-letter queues, the repository, its workflow and the scaling and target groups. Fulfillment dropped the queues described as fulfillment work: "queue-commerce-prod-5 to -8 are described as fulfillment-adjacent, but the graph only connects them to the product-information lane (instances prod-02, -06, -10, -14), so I left them out." Separately, when a question named no environment, the agent assumed production and left the dev resources out. Three conventions of [the conventions experiment](2026-10-11-conventions.md) taught this:
- "Assign compute to an area by its description, confirmed by its deployment pipeline, scaling group and target group."
- "When a description and the graph disagree, answer from the graph."
- "Stay inside the environment the question asks about."

**Hypothesis.** A description says what a resource is for; the graph says what it is connected to. If each answers its own question, and a question that names no environment covers both, the area questions move without a convention written for any one of them.

**Change.** The three lines are rewritten in `src/agent/conventions.ts`. Each part, with the reason it holds whatever the questions ask:
- **A question that names no environment covers both.** A question scoped by nothing is about the whole estate; narrowing it silently hides resources the user did not exclude.
- **A resource belongs to an area by its own description.** The graph has no node for an area, so a description is the only place a purpose is written. Wiring crosses areas here: the production load balancer targets all sixteen production instances, and the queues described as fulfillment work are granted to the roles of instances described as product information.
- **Hedged wording still places a resource in an area.** The descriptions are hedged throughout ("near", "-adjacent", "-flavored", "-style"); reading a hedge as exclusion would leave most areas nearly empty.
- **An area is a business purpose, not a technical pattern.** Background work, events and dead-letter handling belong to the area their description names, and to none when it names none; catalog refreshes are background work too. Fulfillment now means shipping orders, no longer "shipment or background work".
- **One resource can belong to several areas.** Some descriptions name two, such as the buckets for "customer-facing or product-information code paths".
- **An area's resources are the ones that do its work:** instances, load balancers, databases, buckets, queues and monitors. Repositories, workflows, identity, network, and scaling or launch configuration are how those are built, deployed and secured, and the graph reaches them when a question asks. This is the one part taken from the answer key: an engineer could count an area's repository, the key does not, and the convention follows it, as "reach" and "storage" did in the previous experiment. Variant D below measures what it carries.
- **Descriptions and the graph each answer their own question; neither overrules the other.** A description says what a resource is for; relationships say what it is connected to. The old tiebreak let wiring overrule a stated purpose. To find what uses, reaches or watches something, the agent now follows the graph from that resource, not from the compute it expects to use it.

**Variants**, Haiku 5.5 at effort high, three full runs each:

| Prompt | Passed | Precision | Recall | Cost per run | Tool calls |
| --- | --- | --- | --- | --- | --- |
| `1f77e706` (before, on `d8da0fb`) | 25, 25, 25, 24 | 93–95% | 90–91% | $0.10–0.11 | 192–202 |
| `7b9f346c` (A: the three lines, without the hedged wording) | 25, 26, 25 | 95–96% | 91–94% | $0.10–0.11 | 168–170 |
| `03a9639c` (B: A plus the hedged wording, and target groups named among the configuration) | 25, 26, 26 | 95–96% | 94% | $0.09 | 170–184 |
| `1d555744` (C: B without naming target groups; shipped) | 27, 27, 24 | 93–96% | 93–95% | $0.08–0.09 | 165–172 |
| `e77e92de` (D: C without the resource kinds of an area, rejected) | 23, 24, 23 | 95–96% | 94–95% | $0.09–0.10 | 164–184 |

One of A's three run records was overwritten, because two runs started in the same millisecond and got the same file name. Its pass count and per-question table survive in the run's console output; its precision, recall, cost and tool calls are lost.

| Question | Before (11 runs) | A | B | C |
| --- | --- | --- | --- | --- |
| Checkout or order flow | 0 | 3 of 3 | 3 of 3 | 3 of 3 |
| Involved in fulfillment | 2 | 1 of 3 | 3 of 3 | 3 of 3 |
| Storefront or customer-facing traffic | 0 | 0 of 3 | 0 of 3 | 0 of 3 |
| Fulfillment jobs backing up | 0 | 0 of 3 | 0 of 3 | 0 of 3 |
| Order-flow instances' data access | 0 | 0 of 3 | 0 of 3 | 0 of 3 |
| Compute stack in dev | 6 | 1 of 3 | 0 of 3 | 2 of 3 |

**What the resource kinds carry (D).** Without the part that says which kinds make up an area, the description rule also takes in each area's repository, whose description names the area too ("Repository near order-flow behavior"). Checkout, catalog and fulfillment then each failed on that one extra id in all three runs, catalog having passed before. Every kind in this graph carries a description, so a rule that assigns an area by description needs a boundary on the kinds it applies to.

**Moved.** Checkout passes on all nine runs of A, B and C, from none of eleven. Fulfillment passes on all six runs with the hedged wording; without it, the agent read "fulfillment-adjacent" as outside the area (A). Storefront now covers the dev load balancer and instances on six of the nine runs. Cost per run fell by about a fifth and tool calls by about 14%, because the agent no longer walks each lane's plumbing.

**Regressed.** Nothing beyond known flakes. The dev compute stack misses its target groups on some runs, as before the change: the answers list them in the prose and leave them out of `ids`. Naming target groups among an area's configuration (B) coincided with three misses in three runs, and it gained nothing elsewhere, so C drops it. Four questions missed once each in the nine runs:
- the deploy blast radius and the workflows deploying to a database: right prose, but `ids` that also list the workflow and scaling group on the way, or the eight workflows checked;
- the repository behind `i-ecomm-dev-02`: one extra id;
- the queues without a dead-letter queue: answered as the queues outside any redrive.

The repository and workflow questions already missed 1 of 11 before.

**Not fixed, on purpose.**
- **Storefront.** The key counts the monitors that watch customer-facing latency and the product buckets as serving customer-facing traffic. The agent reads "serve traffic" literally and leaves them out.
- **Fulfillment jobs backing up.** The key starts from the queues described as fulfillment work and adds the instances whose permissions reach them. The agent lists the area's workers, and its prose notes that those workers cannot reach the fulfillment queues.
- **Order-flow.** Unchanged: it is the queues-as-data reading.

Each of the first two could be won by a line that exists only for its question, which is the bias these conventions avoid.

**Verdict:** kept, as C. The total alone does not show it: 27, 27, 24 against 25, 25, 25, 24 is within the ±2 that a run moves with nothing changed. With three questions failing on readings these conventions do not take, the prompt's ceiling is 27, so a gain of three on the total was out of reach. The per-question picture carries the verdict: two questions went from failing on almost every run to passing on every run, and none regressed beyond noise. The baseline is retaken on this prompt in the next commit, so later changes are gated against the agent that ships.
