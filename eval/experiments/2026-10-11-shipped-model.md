# The shipped model: Haiku 5.5 instead of Sonnet 5.5 (2026-10-11)

**Revised 2026-10-12:** the Haiku row comes from the four runs of this prompt made before the change was committed; the four on the commit itself (`d8da0fb`, the baseline's runs) passed 25, 25, 25 and 24 with a median of about 11 s per question, against Sonnet's 9 to 10 s, not 14 to 17 s. Across all eleven full Haiku runs of this prompt, local and CI, the questions that fail every time are fulfillment backing up, checkout, storefront and order-flow; "Which resources are involved in fulfillment?" passed in 2 of the 11, so for that question the "Moved" paragraph's "both models miss" holds on Sonnet only (`docs/facts.md`, the last entry). Those questions fail on how the agent read a business area and on an assumed environment, not on the meaning of descriptions; [the business-area experiment](2026-10-12-business-area.md) turns checkout and "involved in fulfillment" into passes on every run.

**Pattern.** On the current prompt (`1f77e706`), Sonnet 5.5 ends some answers in prose without calling `final_answer`: 2, 2 and 3 of 30 in three runs, every one stopping on `end_turn`, never on the token limit. Each is a complete answer written as the reply instead of inside the tool, often a right one: both empty runs of "Can any dev compute instance reach production storage?" say "No", which is the expected answer. Haiku 5.5, on the same prompt and effort, has never ended in prose.

**Hypothesis.** Haiku at effort high is at least as correct as Sonnet on this eval, and it costs about a tenth as much, which matters for an eval that runs on every push.

**Change.** `DEFAULT_MODEL` in `src/agent/agent.ts` goes from `claude-sonnet-5-5` to `claude-haiku-5-5`, so `npm run eval` and a new chat conversation both run Haiku; the chat keeps Sonnet as a choice. The prompt, tools and effort are unchanged.

| Model (prompt `1f77e706`, effort high) | Passed | Empty answers | Precision | Recall | Cost per run | Median per question |
| --- | --- | --- | --- | --- | --- | --- |
| Sonnet 5.5 (before) | 22, 23, 23 | 2, 2, 3 | 94–97% | 94–95% | $1.09–1.40 | 9–10 s |
| Haiku 5.5 (after) | 24, 25, 25, 24 | 0 | 92–96% | 91–94% | $0.11–0.12 | 14–17 s |

Precision and recall are means over the answers that were given, so Sonnet's empty answers do not lower them. The Haiku runs were made with `--model claude-haiku-5-5`, which is the configuration this change makes the default.

**Moved.** Sonnet's empty answers are gone. "Which production resources support catalog or product data?" fails on all three Sonnet runs and passes on all four Haiku runs. Both models miss the same four questions that need the meaning of descriptions (fulfillment backing up, checkout, fulfillment resources, storefront) and the order-flow question whose key counts queues as data resources.

**Regressed.** "What is the compute stack in my dev env?" fails on 2 of 4 Haiku runs, dropping the dev load balancer and its target groups; Sonnet missed it once, by ending in prose. Haiku is slower, about 15 s per question against 10 s, with more queries per answer (188–208 against 143–157 per run).

**Rejected on the way: worked examples.** Four invented questions about a different estate, each showing only its final `final_answer` call (a lookup, a set, a path, a "none"), aimed at Sonnet's habit of ending in prose. Its runs on both models were cut short when the API key reached its usage limit, so it was never measured on full runs; the harness recorded those calls as errors and declined to score the runs. On the questions that did complete, Sonnet still ended in prose 5 times in 79. With Haiku shipping, the examples have no failure left to target, so they are not kept.

**Verdict:** kept. Haiku ships.
