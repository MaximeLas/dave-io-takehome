# The answer against the evidence and against itself: three checks, measured (2026-10-13)

**Pattern.** Not a change to the agent: a measurement of it, as the key audit is. Every check the eval ran compared the answer with the key, so two failures were invisible. An id the agent asserted without having read it (built from a naming pattern, or assumed) counted the same as one it read, and a passing answer whose right id was a guess passed silently. And nothing compared the `ids` the eval scores with the prose the user reads. A third gap was in the work: whether the agent calls the meaning search where a question names a purpose and leaves it alone where the graph's structure answers was known from two runs only ([meaning search](2026-10-12-meaning-search.md)).

**The checks.** All three are code, read off the run record, with no model call (`checkAnswer` and `diagnostics` in `eval/score.ts`):

- **Grounded ids:** every asserted id must appear, as a whole token, in the output of at least one successful call of the two tools that read the graph (`run_cypher`, `search_descriptions`), in the same run. An error's output is not evidence, since it can quote the failing query, ids and all; nor is another tool's, which can echo what the model wrote. Reported per run as the ungrounded ids, printed under the row whether the trial passed or not, and per trial as the runs with any ungrounded id and the ungrounded ids in all.
- **The prose names its ids:** the share of asserted ids the prose names, by full id, by the resource's name from the graph (32 names differ from the id's last segment, [F20](../../docs/facts.md#f20-an-ids-last-segment-is-not-always-the-resources-name)), or by a short form tied to its family: once a sibling is named in full, a run of numbers that starts at a member in full or at the family's word ("queue-commerce-prod-5, -6 and -7", "i-ecomm-prod-02, 06, 10 and 14", "prod-1, 2, 3", "prod-13 to prod-16"). 1 when nothing is asserted; a mean over the non-empty answers per trial. What it measures is whether a reader can pick out each asserted resource from the prose, not whether the prose follows the prompt's wording to the letter: a list of short forms passes, a set named only collectively does not.
- **Search calls:** the calls to `search_descriptions` per run, summed per trial.

In both answer checks the ids the question names count neither way, as in the pass. None of the three gates: each is compared with the baseline once a baseline stores it, and gates once it is steady and has an agreed budget (`AGENTS.md` § Scoring).

**Where the figures come from.** Every figure below is a re-score of saved run records with the new scorer, no model call, from the local run records (not committed):

- **The committed baseline's runs:** the 90 trial runs and 72 second-round runs of the 13 Oct accept (eval `2026-10-12T23-17-42-984Z-claude-haiku-5-5-high`, code `b0fb213`, prompt `1d555744`, baseline commit `8bf30c0`). The re-score reproduces the baseline's pass counts (24, 26, 26) and costs (9.33c, 8.28c, 8.27c) exactly, which checks that it read the same runs the same way.
- **The shipped agent's week:** the 282 eval runs whose fingerprint is the shipped agent's (`a6d81ecf`: Haiku 5.5 at effort high, prompt `1d555744`, both tools), 12 Oct, local.
- **Every saved run of a question:** 1,849 runs from 8 to 12 Oct, every prompt and both models.

**Grounded ids: none ungrounded, anywhere.**

| Records | Runs | Runs with an ungrounded id |
| --- | --- | --- |
| The baseline's three trials | 90 | 0, 0, 0 |
| The baseline's second round | 72 | 0 |
| The shipped agent | 282 | 0 |
| Every question run, 8 to 12 Oct | 1,849 | 0 |

In none of these runs did the answer assert an id that no successful tool output of its run contained. Counting error outputs as evidence would change nothing today (26 of the 168 errors in the 1,849 runs quote an id, and none grounds an id that nothing else printed), but it would leave a way through. The check's first draft flagged three runs in the 1,849, all wrongly: two where a query printed each node as `Entity:aws:…`, which a match requiring a clean boundary before the id missed, and one where the only id never printed was the instance the question names. Both are fixed and tested (`eval/score.test.ts`).

Absence of a flag is weak evidence on this graph. Appearing in a tool output is necessary for having read an id, not proof that it was read for this claim, and runs print many ids: over the shipped agent's 282 runs, the successful outputs print a median of 28 of the graph's 297 ids, and a tenth of the runs more than 139. An id guessed in a broad run can be grounded by accident; the check is sharpest on the narrow questions. So it found no failure this week, and its value is as a guard on the changes most likely to tempt a shortcut (a cheaper model, a lower effort, a tighter token budget).

**The prose names its ids: 98%, and no disagreement found.**

- **The baseline's trials:** 100%, 96%, 100%. Two runs fall below 1, both in trial 2 and both passing: "Which prod resources are related to checkout or order flow?" at 88% and "Which resources are reachable from the largest number of distinct compute instances?" at 4%. In the second round, 1 of 72 runs falls below 1.
- **The shipped agent:** a mean of 97.8% over 282 runs; 274 at 1, 8 below it, 4 of those at 0. All 8 passed.
- **Every question run:** a mean of 97.8% over 1,832 non-empty answers; 76 below 1, 29 at 0.

The 8 runs of the shipped agent below 1, read one by one:

- **Six name the set collectively instead of by id, with no member in full:** the most-shared question in five runs ("Dev queues 1–8, reached by dev instances", "Prod queues 1–16", or "every commerce queue in dev (1–8) and prod (1–16)"), and "Which SQS queues have no dead-letter queue configured?" in one ("dev-5 to dev-8 and prod-13 to prod-16"). The `ids` are right in all six; a reader cannot pick out the resources from the prose without knowing the naming scheme, and the prompt asks the prose to name every resource by its id, so these are true flags, not disagreements.
- **Two are false flags:** a bucket policy written as a partial id ("s3-policy:bucket-commerce-prod-1"), and two monitors called "commerce-3 and commerce-4", the last segment of their ids, which is neither their id nor their name.

None of the eight is a prose that asserts a different set from `ids`. The disagreements seen this week (the workflows question listing the workflows it ruled out, in CI) are of the kind the check cannot see, since a prose that names what it ruled out names ids it did not assert; that remainder is the model judge's ([`docs/metrics.md`](../../docs/metrics.md#where-a-model-judge-would-enter-and-why-none-gates)).

**Why the short forms, and why tied to their family.** Matched by full id or name only, the shipped agent's 282 runs score 83.7%, with 63 runs below 1; with the short forms, 97.8% and 8. The difference is abbreviation, which the prose uses constantly, and a check that flags a fifth of all runs for it is noise a person stops reading. A short form can also credit a resource the prose does not mean, and the first version of the rule did: once a sibling was named in full, any range or list anywhere counted, so "Prod queues 1–16" credited the dev queues, and "1 to 6 hops" would credit members 1 to 6 of any family named once. The rule now requires a run of short forms to start at the family, at a member named in full or at the family's word (`prod-13`). The effect, measured by re-scoring the same records: of the 585 ids the shipped agent's runs had credited through a short form alone, 29 are withdrawn, all in two runs of the most-shared question that name the queues collectively (one from 100% to 8%, one from 33% to 4%), and no other of the 282 runs moves. Over every question run the mean moves from 97.9% to 97.8% and the runs below 1 from 75 to 76; the runs that move there are answers of earlier prompts that name sets collectively ("Queues 1 through 4 redrive into 13 through 16") or call a family by a partial name ("s3 buckets commerce-prod-1 through 6"). One error the rule keeps: two families that share their last word (`queue-commerce-prod-`, `i-ecomm-prod-`) can still credit each other through a run that starts at the word alone. The comment on `namedInProse` in `eval/score.ts` lists both directions of error.

**Search calls: where the agent searches.**

| Question | Runs | Runs with a search | Search calls per run |
| --- | --- | --- | --- |
| Which resources serve storefront or customer-facing traffic? | 7 | 7 | 2.4 |
| Which production resources support catalog or product data? | 10 | 10 | 1.7 |
| Which prod resources are related to checkout or order flow? | 10 | 10 | 1.3 |
| The instances described as order-flow: which data resources do they actually have access to? | 7 | 7 | 1.3 |
| Which resources are involved in fulfillment? | 10 | 10 | 1.2 |
| What should I inspect if fulfillment jobs are backing up? | 7 | 7 | 1.1 |
| If messages in the production order queues keep failing, where do they end up? | 10 | 4 | 0.4 |
| Which Datadog monitors are related to queues or databases? | 10 | 2 | 0.2 |
| Which queues can i-ecomm-prod-04 access? | 10 | 1 | 0.1 |
| The other 21 questions | 201 | 0 | 0 |

The shipped agent's 282 runs, by question. On the baseline's three trials: 11, 11 and 9 search calls, against 164, 160 and 169 tool calls in all.

Six questions search on every run, each naming an area or a purpose, which is what the tool is for. The other 24 split three ways.

- **Over-triggering, once:** one of the 10 runs of "Which queues can i-ecomm-prod-04 access?", a permission question the identity chain answers, searched once. That is the case this count exists to show.
- **Two questions the meaning-search experiment counted as naming a purpose, from two runs,** search in some runs only: "If messages in the production order queues keep failing, where do they end up?" in 4 of 10, "Which Datadog monitors are related to queues or databases?" in 2 of 10. By that experiment's reading, 14 of these 20 runs under-trigger. The traces argue for a narrower one: without a search, the agent answered the monitors question from the `MONITORS` edges and the labels of their targets, and the order-queues question by listing the queues with their descriptions, few enough to read whole, then following `REDRIVES_TO`; both questions are in the baseline's solid set. A search is one way to find a purpose, so skipping it where the edges carry the meaning or the candidates fit on a page is not a miss; a reworded question whose candidates do not fit would show one. The meaning-search file carries a dated revision.
- **The other 21,** the path, permission and count questions, never search.

The earlier reading, from two local runs, was 8 questions that search; over 282 runs it is 6 always and 3 sometimes.

**What the baseline stores.** Nothing yet. The committed baseline (`8bf30c0`, format 2) predates the three checks, so a run compared with it prints each of them as "not in the baseline" and compares every other metric as before. The baseline is not retaken to store them: the agent did not change, so a retake would only re-draw the solid set and both allowances from fresh samples, the neutral retake `AGENTS.md` § Scoring refuses, and every baseline figure in the write-up would move by luck. The next accept made for one of the two reasons there stores them, and the values above, from the same runs re-scored, are the reference until then.

**Not measured.** Whether the prose check's remaining crediting error (two families sharing a last word) occurs on other wordings; the held-out set of the next steps would show it, and the same set would show whether skipping the search ever costs an answer. Duration's tail, the other designed addition to the work layer, is not built.

**Verdict.** Kept, reported and not gated. Grounding and search calls are exact and cheap. The prose share is narrow by construction and says so: it finds prose that names a set collectively, in 6 of the shipped agent's 282 runs, and leaves the real disagreement to a judge.
