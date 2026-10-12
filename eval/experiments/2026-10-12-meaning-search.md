# Search by meaning over the descriptions (2026-10-12)

**Pattern.** Not a failing question this time. The assignment asks for a vector index over the node descriptions and a Graph RAG layer that uses it. Until now the agent found resources by purpose only through words it guessed, `toLower(n.description) CONTAINS 'fulfil' OR … 'ship'`: this works when a question uses the descriptions' own words, as the thirty do, and misses a resource whose description says the same thing in other words ("security group" for "firewall rules"). A resource never found is a wrong answer.

**Hypothesis, written before the eval runs.** On the thirty questions: the same pass count, because their wording matches the descriptions and the agent already finds the resources by words (the business-area experiment's traces show it finding them and then judging); cost not lower, and within the gate's margin. The gain is on wording the thirty do not use, which the offline measurement below shows and the eval cannot. The eval's job here is to show that nothing breaks, and at what cost.

**Change.**
- **The index** (the first commit): `npm run index` embeds each node's description with `all-MiniLM-L6-v2`, run locally and pinned to one revision of its repository, the model Neo4j's own tooling defaults to, and stores the vector on the node in a cosine index queried with Neo4j's `SEARCH` clause ([F25](../../docs/facts.md#f25-vector-search-on-this-server-the-search-clause-integer-dimensions-and-scores-of-1--cos--2), [F26](../../docs/facts.md#f26-the-embedding-model-runs-locally-its-two-onnx-ports-give-the-same-vectors-to-six-decimals)). The query tool prints a vector as `<vector, 384 numbers>`, since nothing in Neo4j hides a property from `properties(n)`. Running the model locally needs no second key and no network call per search; the price is `onnxruntime-node`, about 290 MB of native packages, to embed 79 short texts and one phrase per search.
- **The tool**, `search_descriptions(query, limit = 10)`: the descriptions closest in meaning to the phrase, best first, each with its score and the ids of every resource that carries it (297 resources share 79 descriptions, so a description is never split). The last line gives the score of the best description left out. The description says what the tool is for, how to read a score, and to start with the default and widen only when the last ones shown are still relevant; the prompt does not mention the tool, so the model decides when it helps.
- **The run record** carries the embedding model and its revision.

**Measured offline, before the agent was touched** (`scripts/measure-search.ts`). The dev set, `eval/search-dev-set.json`, holds 22 search phrases written and labelled by Claude Opus 5.5 given only the 79 descriptions, never the eval's questions or the answer key: business areas, technical roles, paraphrases that avoid the descriptions' words, and phrases that match nothing. Its area phrases ("product catalog", "fulfillment") resemble the eval's area questions because the descriptions name those areas themselves. Choosing the cutoff on the eval's questions would have tuned the tool on the test it is scored by.

| Ranking of all 79 descriptions, on the 19 phrases with a relevant one | MAP | Recall in the top 10 |
| --- | --- | --- |
| Vectors, description alone | 74% | 83% |
| Vectors, name and description (Neo4j's examples embed a title with the text) | 71% | 85% |
| Neo4j's full-text index (BM25), the standard keyword baseline | 40% | 41% |

Full-text returns only descriptions sharing a word with the phrase, and never returns 47% of the relevant ones. The vectors' lead is on wording: by role ("message queues", "permissions and roles") 85% against 26%, on paraphrases 60% against 25%, and level (82%) when the phrase uses the descriptions' words. The name adds nothing, so the index embeds the description alone.

The fairer baseline is the agent's own way of searching. Two Claude Haiku 5.5 instances, the agent's model, given the same prompt (the 22 phrases and one example of the agent's query style, on a subject not in the set) and nothing else, wrote the word lists they would OR together for each phrase (`eval/search-word-lists.json`):

| Set returned | Precision | Recall | Relevant never returned |
| --- | --- | --- | --- |
| Vectors, top 10 descriptions | 46% | 81% | 19% |
| Word lists, first writer | 63% | 80% | 20% |
| Word lists, second writer | 73% | 88% | 12% |
| First writer's words and the vectors' top 10 | 41% | 91% | 9% |
| Second writer's words and the vectors' top 10 | 41% | 93% | 7% |

Alone, the vectors do not beat the agent's word lists: the descriptions are templated in a small vocabulary ("order-flow", "fulfillment-style") that a model fluent in cloud terms guesses well. Together, the relevant descriptions never found fall from 20% to 9% and from 12% to 7%, at a precision the agent restores by reading each description. So the tool is a complement to word matching, not a replacement. The two writers differ (80% and 88% recall), two samples of how much guessing varies; the vectors do not vary.

**The cutoff.** A fixed score threshold is the intuitive cut, and it lost: the best one (a score of at least 0.62) found less than the top 10 (recall 75% against 81%) and was no cleaner on phrases that match nothing. Scores are not comparable from one phrase to the next, the textbook warning about embedding scores; a margin below each phrase's best score fitted the relevant ones best but returned 44 of the 79 descriptions for a phrase that matches nothing. Ten descriptions, every score shown and a way to ask for more, is the shape Anthropic's guidance on tool design gives any tool that can return a lot: a sensible default, truncation that says so, and a parameter to get more.

**First version, and what review changed.** The first description ended "when the last ones shown are still relevant, search again with a larger limit". The model never used the default: it asked for 15 to 80 descriptions up front, so the cut measured offline did not govern what shipped, and each search returned more to read than it needed. The revised description asks for the default first and a wider search only when the tail is still relevant, since the next descriptions are then likely to be relevant too. Its example of other wording changed from shipping for fulfillment, a reading the conventions took from the answer key, to firewall rules for security groups.

**The eval**, three trials per run, against the baseline taken on the agent before this change (`0c204d8`):

| | Before | First version, local | First version, CI | Revised, local |
| --- | --- | --- | --- | --- |
| Passed | 25, 26, 26 | 26, 24, 26 | 25, 26, 26 | 25, 25, 26 |
| Mean cost per trial | $0.089 | $0.092 | $0.088 | $0.091 |
| Mean tool calls per trial | 171.7 | 165 | 164.3 | 168 |
| Mean Cypher errors per trial | 3.3 | 1.3 | 1.7 | 1.7 |
| Gate | | held | rule 2 failed | held |

Score and cost are the same within noise in every run. Tool calls and Cypher errors are lower in all three, but within the per-trial spread (the first local run's tool calls were 176, 157 and 162), so they are not claimed as gains.

**The CI run's red.** Rule 2 failed on "Do any GitHub workflows deploy directly to a database?", which passed 1 of 3: two trials listed the eight workflows they had checked in `ids`, where the answer is none. That question called no search in any of the six local trials, and it failed one of them the same way; it had passed 10 of 11 runs before this change ([F24](../../docs/facts.md#f24-four-questions-failed-on-every-run-of-prompt-1f77e706-and-four-more-on-some-runs)). A question that slips once in ten fails two of three trials in about one run in thirty-five; with 25 questions held to that rule, a run with nothing changed fails it now and then. The red is the gate working as written on a flaky question, not the change.

**Where search was called.** In both local runs, on the same 8 of the 30 questions, every one naming a purpose: the four business areas, fulfillment jobs backing up, the order-flow instances' access, the production order queues, and the monitors on queues and databases. Never on a question the graph's structure answers (paths, permissions, dead-letter wiring, counts). With the revised description, the 32 calls asked for 10 descriptions 8 times, 15 eighteen times and never more than 30 (the first version asked for up to 80), and 4 searches widened an earlier one. The model still prefers a little more than the default on area questions; whether asking for exactly the default saves anything measurable is not shown at this size.

**Moved.** Two questions flip in the runs, both on the answer's `ids`, not on what was found:
- "If messages in the production order queues keep failing, where do they end up?" passed 2 of 3 in both local runs (3 of 3 before). The failing trials list the four source queues beside their dead-letter queues; the prose is right in every trial. In the revised run the failing trial made no search, so the slip does not come from the tool.
- "Do any GitHub workflows deploy directly to a database?", above.

"Which repository's code ends up on i-ecomm-dev-02?" and "What is the compute stack in my dev env?" moved within their known spread, with no search. The three questions that fail on purpose ([the business-area experiment](2026-10-12-business-area.md)) still fail, the same way, with the search called in each: it finds the area's resources, and the reading of the question decides the answer, as before.

**Not measured.** Whether the search turns into correct answers on questions worded unlike the descriptions. The offline measurement shows the mechanism (fewer relevant resources never found); an end-to-end check needs a second, small question set with its own key, run with and without the tool.

**Verdict:** kept, as the revised version. The hypothesis held: the same score and cost within noise. The agent calls the search where a question names a purpose and leaves it alone elsewhere, which is the behaviour the tool's description asks for without a line in the prompt. The case for it is the one measured offline, a second way to find a resource whose description uses other words than the agent's, and the requirement it fulfils; the thirty questions cannot show that gain, and this file does not claim it.
