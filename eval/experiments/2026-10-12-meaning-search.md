# Search by meaning over the descriptions (2026-10-12)

**Pattern.** Not a failing question this time. The assignment asks for a vector index over the node descriptions and a Graph RAG layer that uses it. Until now the agent found resources by purpose only through words it guessed, `toLower(n.description) CONTAINS 'fulfil' OR … 'ship'`: this works when a question uses the descriptions' own words, as the thirty do, and misses a resource whose description says the same thing in other words ("security group" for "firewall rules", "fulfillment-style" for "shipping and delivery"). A resource never found is a wrong answer.

**Hypothesis, written before the eval runs.** On the thirty questions: the same pass count, because their wording matches the descriptions and the agent already finds the resources by words (the business-area experiment's traces show it finding them and then judging); cost per run not lower and probably slightly higher, because a second tool's description rides on every model call and searches add calls. The gain is on wording the thirty do not use, which the offline measurement below shows and the eval cannot. The eval's job here is to show that nothing breaks, and at what cost.

**Change.**
- **The index** (the previous commit): `npm run index` embeds each node's description with `all-MiniLM-L6-v2`, run locally, the model Neo4j's own tooling defaults to, and stores the vector on the node in a cosine index queried with Neo4j's `SEARCH` clause ([F25](../../docs/facts.md#f25-vector-search-on-this-server-the-search-clause-integer-dimensions-and-scores-of-1--cos--2), [F26](../../docs/facts.md#f26-the-embedding-model-runs-locally-its-two-onnx-ports-give-the-same-vectors-to-six-decimals)). The query tool prints a vector as `<vector, 384 numbers>`, since nothing in Neo4j hides a property from `properties(n)`.
- **The tool**, `search_descriptions(query, limit = 10)`: the descriptions closest in meaning to the phrase, best first, each with its score and the ids of every resource that carries it (297 resources share 79 descriptions, so a description is never split). The last line gives the score of the best description left out, so the model can ask for more when the tail is still relevant. Its description says what it is for and how to read a score; the prompt does not mention it, so the model decides when it helps.
- **The run record** carries the embedding model's id.

**Measured offline, before the agent was touched** (`scripts/measure-search.ts`). The dev set, `eval/search-dev-set.json`, holds 22 search phrases written and labelled by a reviewer who saw only the 79 descriptions, never the eval's questions or the answer key: business areas, technical roles, paraphrases that avoid the descriptions' words, and phrases that match nothing. Choosing the cutoff on the eval's questions would have tuned the tool on the test it is scored by.

| Retriever, on the 19 phrases with a relevant description | Ranking quality (MAP) | Relevant never returned |
| --- | --- | --- |
| Vectors, description alone | 74% | 0% |
| Vectors, name and description (Neo4j's examples embed a title with the text) | 71% | 0% |
| Neo4j's full-text index (BM25), the standard keyword baseline | 40% | 47% |

The vectors' lead is on wording: by role ("message queues", "permissions and roles") 85% against 26%, on paraphrases 60% against 25%, and level (82%) when the phrase uses the descriptions' words. The name adds nothing, so the index embeds the description alone.

The fairer baseline is the agent's own way of searching. Two writers on the agent's model (Haiku), each blind to the descriptions, the labels and the other writer, wrote the word lists they would OR together for each phrase (`eval/search-word-lists.json`):

| Set returned | Precision | Recall | Relevant never returned |
| --- | --- | --- | --- |
| Vectors, top 10 descriptions | 46% | 81% | 19% |
| Word lists, first writer | 63% | 80% | 20% |
| Word lists, second writer | 73% | 88% | 12% |
| First writer's words and the vectors' top 10 | 41% | 91% | 9% |
| Second writer's words and the vectors' top 10 | 41% | 93% | 7% |

Alone, the vectors do not beat the agent's word lists: the descriptions are templated in a small vocabulary ("order-flow", "fulfillment-style") that a model fluent in cloud terms guesses well. Together, the two halve what the words miss, at a precision the agent restores by reading each description. So the tool is a complement to word matching, not a replacement: its description offers it for resources described in other words than the model's, and leaves the query tool as it was. The two writers' spread (88% against 80% recall) is the run-to-run variance of guessing; the vectors have none.

**The cutoff.** A fixed score threshold is the intuitive cut, and it lost: the best one (a score of at least 0.62) found less than the top 10 (recall 75% against 81%) and was no cleaner on phrases that match nothing. Scores are not comparable from one phrase to the next, which is the textbook warning about embedding scores; a margin below each phrase's best score fitted the relevant ones best but returned 44 of the 79 descriptions for a phrase that matches nothing. Ten descriptions, with every score shown and a way to ask for more, is the shape Anthropic's guidance on tool design recommends for any tool that can return a lot: a sensible default, truncation that says so, and a parameter to get more.

**The eval**, three trials on the gate, against the baseline taken on the agent before this change (`0c204d8`):

| | Before | With search |
| --- | --- | --- |
| Passed | 25, 26, 26 (mean 25.7) | 26, 24, 26 (mean 25.3) |
| Cost per trial | $0.088, $0.094, $0.086 (mean $0.089) | $0.096, $0.092, $0.089 (mean $0.092) |
| Tool calls per trial, mean | 171.7 | 165 |
| Cypher errors per trial, mean | 3.3 | 1.3 |
| Mean recall | 94% | 95% |

All three rules of the gate held: the mean pass count above its floor of 24.7, every question that passed all three baseline trials passing at least two, and the mean cost under its ceiling of $0.097.

**Where search was called.** On 8 of the 30 questions, 29 calls in all, and only where a question names a purpose: the four business areas, fulfillment jobs backing up, the order-flow instances' access, the production order queues, and once the monitors on queues and databases. Never on a question the graph's structure answers (paths, permissions, dead-letter wiring, counts). The model never kept the default of ten: it asked for 15 to 80 descriptions, and in 7 of the 24 runs that searched it searched again, mostly with a larger limit ("catalog product data" at 30, then 80). It then confirmed what it found with `run_cypher`, as the tool's description asks.

**Moved.** Three questions changed against the baseline, none beyond the known run-to-run spread:
- "If messages in the production order queues keep failing, where do they end up?" passed 2 of 3 (3 of 3 before). The same search returned the same ranking in all three trials, and all three answers name the right dead-letter queues in their prose; the failing trial also listed the four source queues in `ids`. One trial cannot tie that to the search; it is the question to watch in the next runs.
- "Which repository's code ends up on i-ecomm-dev-02?" passed 1 of 3 (2 of 3 before), with no search: the extra workflow id it has added before ([F24](../../docs/facts.md#f24-four-questions-failed-on-every-run-of-prompt-1f77e706-and-four-more-on-some-runs)).
- "What is the compute stack in my dev env?" passed 1 of 3 (none before), with no search: the target groups it has always dropped on some runs.

The three questions that fail on purpose ([the business-area experiment](2026-10-12-business-area.md)) still fail, the same way, with the search called in each: the search finds the area's resources, and the reading of the question decides the answer, as it did before.

**Not measured.** Whether the search turns into correct answers on questions worded unlike the descriptions. The offline measurement shows the mechanism (half the misses of word matching); an end-to-end check needs a second, small question set with its own key, run with and without the tool.

**Verdict:** kept. The hypothesis held: the same score within noise, cost up 3% (inside the gate's measured margin), fewer tool calls and Cypher errors. The agent calls the search where a question names a purpose and leaves it alone elsewhere, which is the behaviour the tool's description asks for without a line in the prompt. The case for it is the one measured offline, a second way to find a resource for wording the agent's own words miss, and the requirement it fulfils; the thirty questions cannot show that gain, and this file does not claim it.
