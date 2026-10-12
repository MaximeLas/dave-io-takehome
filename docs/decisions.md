# Decisions

The design decisions behind this work, one entry per choice a reviewer is likely to question, each headed by that question; the condensed list of the nine main ones is in [`SOLUTION.md` § Decisions](../SOLUTION.md#decisions).

An entry gives the choice, the options rejected with the reason each lost, the evidence with its frame (which runs, on which model and prompt, which committed file), and the observation that would reopen it. Where a first choice was later revised, the entry says what was chosen first, what was learned, and what replaced it.

The entries follow the order the system is read in: the agent, retrieval, the answer, the eval, the gate, the server. Each ends with what would change it.

Numbers come from committed files only: the experiment files in [`eval/experiments/`](../eval/experiments/README.md), the [baseline](../eval/baselines/claude-haiku-5-5.high.json), commit messages, and [`docs/facts.md`](facts.md), where the `F` ids resolve.

"Three runs" means three full runs of the thirty questions, and the model is Claude Haiku 5.5 at effort high, unless an entry says otherwise.

**Contents**

- The agent: [one entry point](#why-one-package-with-one-entry-point-shared-by-the-chat-and-the-eval), [one generic query tool](#why-one-generic-cypher-tool-and-not-a-tool-per-question-shape), [the conventions](#how-were-the-reading-conventions-kept-from-fitting-the-thirty-questions), [queues and data](#why-are-queues-not-data-resources-when-the-key-counts-them-once), [the model](#why-ship-haiku-at-effort-high-rather-than-sonnet)
- Retrieval: [local embeddings](#why-a-local-embedding-model-rather-than-a-hosted-one), [the search's cut and role](#why-a-top-10-search-beside-word-matching-and-not-a-similarity-threshold)
- The answer: [a tool call with ids](#why-does-the-answer-come-through-a-tool-call-with-separate-ids-and-not-as-prose)
- The eval: [exact match](#why-exact-match-on-ids-and-not-recall-above-a-threshold), [a hand-built harness](#why-a-hand-built-harness-rather-than-langsmith-or-braintrust), [the key as reference](#why-trust-the-answer-key-and-what-happens-where-it-reads-a-question-differently)
- The gate: [every pull request](#why-does-the-eval-gate-every-pull-request-and-push-to-main), [three trials](#why-three-trials-against-a-three-trial-baseline-and-not-one-run-or-five), [the baseline moves on purpose](#why-does-the-baseline-move-only-on-purpose-and-not-after-every-green-run)
- The server: [multi-turn, in memory](#why-a-multi-turn-chat-on-the-same-entry-point-with-memory-that-does-not-survive-a-restart)

## The agent

### Why one package with one entry point, shared by the chat and the eval?

**Choice.** One npm package with a folder per part (`src/graph`, `src/search`, `src/agent`, `src/server`, `web`, `eval`). The server and the eval harness both call `runAgent` in `src/agent/run.ts`, which returns the run record both store.

**Why.** A regression eval protects production only if it scores the code production runs. With one entry point, no path from a user's message to an answer escapes what the eval exercises: the same model defaults, prompt, tools and answer shape. The only difference is the thread id ([the server](#why-a-multi-turn-chat-on-the-same-entry-point-with-memory-that-does-not-survive-a-restart)).

**Rejected.**

- A workspace of separate packages for the agent, the server and the eval: build and versioning overhead that pays off with several teams or deployables, and this project has neither.
- An eval-specific wrapper around the agent (its own prompt suffix or output parser): it would score something that never ships.

**Evidence.** `eval/harness.ts` and `src/server/chat.service.ts` both call `runAgent`, and the run page (`web/run.html`) reads a chat turn's record and an eval question's record alike, because they are the same record.

**What would change it.** A second consumer with its own release cycle, such as another product embedding the agent. The agent would then become a package of its own; the invariant, one entry point that both the eval and production call, would stay.

### Why one generic Cypher tool and not a tool per question shape?

**Choice.** One tool, `run_cypher`, runs a Cypher query the model writes. Its safety and honesty sit in its interface, not in limits on what can be asked:

- a read transaction the server enforces ([F17](facts.md#f17-a-read-mode-transaction-refuses-writes-on-the-server));
- the row count first, and a 100-row cap that says how many rows there were;
- errors returned as text, for the model to repair;
- the server's warnings on unknown labels and relationship types, forwarded ([F18](facts.md#f18-unknown-labels-and-relationship-types-are-warnings-not-errors));
- a 30-second timeout.

**Rejected.**

- Specific tools first (a dead-letter lookup, an access-chain walk): each is a query guessed before any measurement, and the thirty questions span more shapes than a handful of tools covers.
- A keyword filter as the read-only guard: writes can hide in procedure calls, and legitimate text contains the keywords.
- A read-only database user: the Community edition the fixture ships has no roles.

**Evidence.** The baseline's three trials (13 Oct, prompt `1d555744`) made 160 to 169 tool calls each, with 4, 0 and 5 Cypher errors. On the first scored runs (commit `e4ddc69`), mean recall was near 90%: the failures were in what the answers claimed, not in what the queries found. None of the failures diagnosed in the experiment files since was a query the model could not write.

**What would change it.** Traces showing one query shape written wrong again and again, or schema discovery dominating the turns: then a specific tool beside the generic one, or the schema in the prompt, each measured. A much larger graph would revisit the cap and the timeout.

### How were the reading conventions kept from fitting the thirty questions?

**Choice.** The prompt carries conventions (`src/agent/conventions.ts`) saying what a question's words mean on this estate. The first set was written by a Claude agent given only the live graph, never the questions, the key or any run, and asked for the guide it would hand a new engineer. Where its readings differed from the key's, both were measured and the key's adopted. No line names a question.

**Why this is not tuning to the test.** The key's sets follow rules ([F21](facts.md#f21-the-answer-key-is-generated-by-a-script-outside-this-repository)) and are the only record of this estate's vocabulary. Adopting "reach means permission" changes every question with that word. No line was written for a single question, though the storefront miss could be won by one ([Known misses](../SOLUTION.md#known-misses)).

**Rejected.**

- A line written for one question: a patch that fits the eval. What was done instead, once, is a general line rewritten from a failure pattern seen in the traces (below).
- The blind guide's readings (network rules for "reach", buckets only for "storage"): 22, 21, 21 against 24, 25, 25 with the key's ([conventions](../eval/experiments/2026-10-11-conventions.md)). On "reach" the graph sides with the key: no security-group rule admits any of the 13 declared calls ([F22](facts.md#f22-the-key-reads-reach-and-connect-as-permission-and-storage-and-data-as-buckets-and-databases-with-one-exception)).

**Revised.** Three blind lines taught the agent to model a business area as a lane of compute and to assume production when no environment was named. Rewritten as general lines from that failure pattern, not for any one question, checkout went from 0 of 11 runs to 9 of 9, fulfillment from 2 of 11 to 6 of 6 ([business area](../eval/experiments/2026-10-12-business-area.md)). One more reading came from the key, which kinds make up an area; without it, 23, 24, 23.

**The cost.** Rewritten from the traces, the lines were chosen on the eval itself. Four variants of the wording were measured; the one that shipped beat its closest alternative, identical except that it also named target groups among an area's configuration, on totals inside the run-to-run noise (27, 27, 24 against 25, 26, 26), so its gain is not held-out evidence. With three readings taken from the key, the score is also partly fitted to it ([Known misses](../SOLUTION.md#known-misses)).

**What would change it.** A held-out reworded set scoring well below the thirty.

### Why are queues not data resources, when the key counts them once?

**Choice.** "Storage" and "data resources" mean buckets and databases; queues carry messages.

**Why.** The key reads "data" two ways. "The instances described as order-flow: which data resources do they actually have access to?" expects four queues; "Which production data resources have no monitoring?" expects none, although 14 of the 16 production queues have no monitor ([F22](facts.md#f22-the-key-reads-reach-and-connect-as-permission-and-storage-and-data-as-buckets-and-databases-with-one-exception)). One convention can satisfy only one of the two. Rather than guess, the question went to dave.io, which confirmed that queues are not data resources ([conventions](../eval/experiments/2026-10-11-conventions.md)).

**Rejected.**

- Counting queues as data: it passes the order-flow question and fails the unmonitored-data one, and a cloud engineer reads a queue as transport, not storage.
- A line scoped to the order-flow question: a patch for one question, the bias the conventions avoid.

**Evidence.** In the conventions experiment (three runs per side), the unmonitored-data question was one of four that went from 0 or 1 of 3 runs to 3 of 3, and the order-flow question went from 2 of 3 to 0 of 3. It has failed every run since and is one of the three [known misses](../SOLUTION.md#known-misses).

The key audit ([below](#why-trust-the-answer-key-and-what-happens-where-it-reads-a-question-differently)) amends the order-flow set in its overlay on this reasoning, so the question passes against the amended key and stays a miss against the key itself, which the gate reads.

**What would change it.** dave.io defining data otherwise.

### Why ship Haiku at effort high rather than Sonnet?

**Choice.** Claude Haiku 5.5 at effort high is the default for the eval and a new chat; the chat keeps Sonnet 5.5 as an option. Comparisons set the effort explicitly, as the API's default differs by model.

**Evidence.** Full runs of each on prompt `1f77e706`, effort high ([shipped model](../eval/experiments/2026-10-11-shipped-model.md)):

- passes: Sonnet 22, 23, 23; Haiku 24, 25, 25, 24, inside the run-to-run spread of about two;
- answers ending in prose without `final_answer`: Sonnet 2, 2 and 3 of 30, often with the right answer in the prose; Haiku none;
- cost per run of thirty: Sonnet $1.09 to $1.40, Haiku $0.11 to $0.12;
- speed: Haiku about 11 s per question at the median (the four runs on the shipping commit), Sonnet 9 to 10 s, with Haiku making more queries.

A tenth of the cost and an intact answer contract, for about a second more per question: with ninety agent runs on every pull request, cost decides.

**Rejected.**

- Sonnet as the default: no better score, broken answers, ten times the cost of each CI run.
- Worked examples to cure Sonnet's prose endings: cut short by the API key's usage limit, never measured in full; with Haiku shipping, no failure left to target.
- Opus: not measured, and kept out of the chat so no request can pick the most expensive model.

**What would change it.** A question family Haiku fails on capability rather than reading, or a latency budget for the chat. A cheaper model or a lower effort is unmeasured and would be judged against its own baseline (`--model`, `--effort`).

## Retrieval

### Why a local embedding model rather than a hosted one?

**Choice.** `all-MiniLM-L6-v2`, the model Neo4j's own tooling defaults to, runs in Node through `@huggingface/transformers`, pinned to one revision; the index name carries both, so a stale index reads as missing ([F26](facts.md#f26-the-embedding-model-runs-locally-its-two-onnx-ports-give-the-same-vectors-to-six-decimals)). The vectors sit on the nodes, in a cosine index queried with the `SEARCH` clause ([F25](facts.md#f25-vector-search-on-this-server-the-search-clause-integer-dimensions-and-scores-of-1--cos--2)).

**Why.** Anthropic offers no embedding model, so a hosted one means a second provider and a second secret in every clone and in CI, and a network call per search, to embed 79 distinct descriptions.

**Rejected.**

- A hosted embedding API: the second key and the network dependency, for a corpus this small.
- Embedding the name with the description, as Neo4j's examples do: it added nothing on the dev set (MAP 71% against 74%).

**The price.** About 290 MB of native packages (`onnxruntime-node`), and a 90 MB model downloaded on first use.

**Evidence.** On 22 search phrases written and labelled by Claude Opus 5.5 from the descriptions alone ([meaning search](../eval/experiments/2026-10-12-meaning-search.md)), the local vectors ranked better than Neo4j's full-text index: mean average precision (MAP, where 100% ranks every relevant description first) of 74% against 40%, with the lead on paraphrases. Whether a stronger model would do better was not measured.

**What would change it.** Longer or more varied descriptions, where a stronger model beats this one on a labelled dev set; a deployment where install size matters. The model sits behind one function (`src/search/embed.ts`), so a swap is that file and a re-index.

### Why a top-10 search beside word matching, and not a similarity threshold?

**Choice.** `search_descriptions` returns the 10 descriptions closest to a phrase, with their scores and the score of the best one left out; the model may ask for more. It ships as a complement to the agent's own word guessing (`CONTAINS` filters), not a replacement.

**Against the textbook.** The standard warning against a fixed threshold is that embedding scores are not comparable across queries, and the dev set agreed. The tool follows Anthropic's tool-design guidance instead: a default, truncation that says so, a parameter for more.

**Rejected** (on the dev set, [meaning search](../eval/experiments/2026-10-12-meaning-search.md)):

- The best fixed threshold: recall 75% against 81% for the top 10.
- A margin below each phrase's best score: 44 of 79 descriptions for a phrase that matches nothing.
- Vectors in place of word guessing: two Claude Haiku 5.5 instances writing the agent's style of word lists reached recall of 80% and 88%, against 81%. Combined, the relevant descriptions never found fell from 20% to 9% and from 12% to 7%.

**Revised.** The first tool description invited wider searches, and the model asked for 15 to 80 descriptions up front; the revised one asks for the default first.

**Evidence on the eval.** 25, 25, 26 passes at $0.091 a trial, against the 12 Oct baseline's 25, 26, 26 at $0.089, as predicted beforehand. With no line in the prompt about it, search was called on the same 8 questions in both local runs, each naming a purpose.

**What would change it.** A held-out reworded set showing whether search turns into correct answers on unfamiliar wording.

## The answer

### Why does the answer come through a tool call with separate ids, and not as prose?

**Choice.** Every answer is a `final_answer` call with `answer`, the prose the user reads, and `ids`, the resources that answer what was asked. The chat shows the prose with the ids as tags; the eval scores the ids. The library's tool strategy delivers it, with a middleware that leaves the tool choice to the model ([F1](facts.md#f1-structured-output-toolstrategy-with-the-tool-choice-left-to-the-model)). A run that ends in prose is recorded as an empty answer and fails.

**Rejected.**

- Searching the prose for ids: a good answer names what it ruled out, and ids nest (`queue-commerce-prod-1` prefixes `-prod-10` to `-16`).
- A second model call to extract the ids: a second place to be wrong, and the eval would score the extractor.
- The provider's native structured output: it constrains every turn, and the model answered empty without querying ([F1](facts.md#f1-structured-output-toolstrategy-with-the-tool-choice-left-to-the-model)).
- A retry when the model ends in prose: it hides what the prompt should fix and the eval should count.

**Revised.** The first field text, "every resource the answer asserts ... every node on a path", read as everything the answer touched, hops and context included. The `ids` rule (commit `03a1f56`) defines them as the resources that answer the question, one text serving as both prompt paragraph and schema description. Passes went from 13, 11, 10 to 20, 21, 21, precision from 61 to 74% to 84 to 86%, recall unchanged ([ids rule](../eval/experiments/2026-10-11-ids-rule.md)).

**What would change it.** A model API that reliably constrains only the final turn, replacing the middleware; or prose and ids disagreeing often in real use, the first candidate for a judge.

## The eval

### Why exact match on ids, and not recall above a threshold?

**Choice.** A question passes when the ids the answer asserts equal the key's exactly (`eval/score.ts`). Ids the question itself names count neither way. An empty answer never passes, even when the key expects none: no answer is not an answer of "none".

**Why.** Extra resources make an answer wrong for whoever acts on it: "Do any GitHub workflows deploy directly to a database?" answered with the eight workflows it checked says yes. Padding was also the largest failure family: on the first scored runs, 13 or 14 of the 17 to 20 failures per run missed nothing and only added ids, with mean recall near 90% ([ids rule](../eval/experiments/2026-10-11-ids-rule.md)).

**Rejected.**

- Recall above a threshold: it would have scored that agent as mostly right and hidden the defect the first change fixed.
- Partial credit per question (an F1 score): a second threshold to argue over; recall and precision are reported beside every row instead.
- A model judge for correctness: the key is a set, and set equality is free, exact and repeatable.
- Named ids as required or forbidden: the key includes the named resource in only one of the ten questions that name one ([F21](facts.md#f21-the-answer-key-is-generated-by-a-script-outside-this-repository)).

**Evidence.** `eval/score.test.ts` checks the grader itself: the key scored against itself passes all thirty, and an empty answer fails all thirty.

**What would change it.** Questions whose answer is not a set, such as the prose's quality, which need a judge checked against a person's labels; or the key audit recording a second valid set for a question.

### Why a hand-built harness rather than LangSmith or Braintrust?

**Choice.** The harness is three small modules: `eval/harness.ts` runs the questions through `runAgent`, `eval/score.ts` scores each answer, and `eval/baseline.ts` holds the gate. The baseline is a JSON file committed beside the code, and every run's full trace is a local record that `web/run.html` lays out.

**Why.** The score is a set equality, the gate is three rules over a versioned file, and CI needs one secret, the Anthropic key. A hosted platform would add a second key and a service for what `runs/` and `eval/baselines/` already hold, and the baseline would live outside the git history that dates every change to it. LangSmith tracing stays available without code: two environment variables turn it on for the whole LangChain stack (`src/agent/record.ts`).

**Rejected.**

- LangSmith or Braintrust as the eval's runner and store: a second key and a service in every clone and in CI, and the baseline's history outside git.
- A dashboard across runs: at this size, the Actions history, the run artifacts and the git history of `eval/baselines/` cover it.

**Evidence.** In CI the 90 agent runs of one eval take about 100 seconds and 27 cents ([run 38269765485](https://github.com/MaximeLas/dave-io-takehome/actions/runs/38269765485)), and the gate's verdict is one tested function (`eval/baseline.test.ts`).

**What would change it.** A model judge, whose verdicts need annotation queues for a person's labels; several people reviewing traces; or comparisons across many agents and many runs. Each is what those platforms are built for.

### Why trust the answer key, and what happens where it reads a question differently?

**Choice.** The key (`eval/expected.generated.json`) is the only judge in code and is never edited. Where it reads a question one way among several, the reading is recorded with re-runnable evidence ([F21](facts.md#f21-the-answer-key-is-generated-by-a-script-outside-this-repository) to [F23](facts.md#f23-how-the-key-reads-a-business-area-by-the-resources-own-description-across-environments)), then adopted as a general convention or left as a known miss with its reason. Where it contradicts itself, the question went to dave.io.

**The audit.** A Claude agent (Claude Opus 5.5) re-derived every answer from the graph on 13 Oct, each with its reading, its Cypher query and a verdict ([`eval/key-audit.md`](../eval/key-audit.md)): 28 of 30 agree with the key, one is ambiguous (the storefront question, where the key's area reading stands), one is a key error (the order-flow question, where the key counts queues as data and covers production only, against its own other answers). The one amendment lives in [`eval/key-overlay.json`](../eval/key-overlay.json) with its reason; `npm run eval` prints the score against both, and the gate reads the key alone ([the experiment](../eval/experiments/2026-10-13-key-audit.md): 26, 26, 27 against the key, 27, 27, 28 against the amended key, one three-trial run).

**Why.** The key was generated by a script outside this repository, so each set is exact for its generator's reading of an English sentence, and an audit in the open beats trusting or overriding it in silence.

**Rejected.**

- Editing the key: every committed score would stop being comparable, and the file belongs to the assignment.
- Per-question exceptions in the grader: they hide where the agent and the key disagree.
- The key as unaudited ground truth: "Which resources are reachable from the largest number of distinct compute instances?" has two correct answers on correct data, 24 queues by permission or three security groups by any path ([F22](facts.md#f22-the-key-reads-reach-and-connect-as-permission-and-storage-and-data-as-buckets-and-databases-with-one-exception)).

**Evidence.** Of the three questions that fail on every run, the audit finds one the key's error, one a fair ambiguity and one the agent's ([Known misses](../SOLUTION.md#known-misses)).

**What would change it.** A second reader reaching different verdicts on the same queries; or dave.io supplying the generator, turning inferred readings into stated ones.

## The gate

### Why does the eval gate every pull request and push to main?

**Choice.** One GitHub Actions workflow (`.github/workflows/eval.yml`) runs the typecheck, the tests, Neo4j from the provided compose file, the index build and `npm run eval` on every pull request and push to `main`. The eval's exit code is the job's, and the check is required on `main`. The key reaches the eval step only.

**Why.** A regression check is worth most before the merge: one that runs after it lets the regression ship.

**Rejected.**

- Path filters that skip documentation changes: the eval reads `eval/QUESTIONS.md`, so a filter on Markdown would skip a change to the questions.
- Testing the pull request's head instead of GitHub's merge commit: the merge result is what lands; the price is a record naming a temporary commit.
- Editing the provided compose file's health check, which a 2-core runner often missed: the workflow waits on the database itself.

**Revised.** The first workflow (commit `cd4d249`) ran one eval per change against a one-run baseline with a tolerance of 2. Three trials and three rules replaced that ([next entry](#why-three-trials-against-a-three-trial-baseline-and-not-one-run-or-five)); the workflow stayed.

**Evidence.** Pull request #1 went green. Pull request #2, a deliberate regression with the ids emptied, went red with 2 passes and was closed. A failure before scoring exits 2, not the regression code 1 (commit `d65722a`).

**What would change it.** A question set large enough that ninety runs per pull request cost too much or take too long: then a sample on pull requests and the full set on `main`.

### Why three trials against a three-trial baseline, and not one run, or five?

**Choice.** `npm run eval` runs every question three times and holds three rules against a three-trial baseline (`eval/baseline.ts`): on the mean pass count, on every question in the solid set (it must pass two of three), and on the mean cost. Each allowance is the spread of the three accept trials, floored at one pass and 5% of the cost. The solid set is earned at accept over six draws: the three trials, then a second round in which each question that passed them all runs up to three more times alone, stopped at its first failure.

**Why not one run.** One run against one stored run needed a wide tolerance: the first baseline (commit `2520733`) failed below 22 while the agent usually scored 25, letting three working questions go, and cost went ungated.

**Why not five.** About 45 cents per pull request instead of 27, for a standard error about 1.3 times smaller. What remained after three trials was a question entering the solid set by three lucky passes (42% for one that passes 75% of the time), and a second accept round fixes that more cheaply: it is paid once per accept, not on every pull request.

**Rejected.**

- A cost rule that relaxes when the score rises: it needs an exchange rate between cents and questions.
- Five trials at one accept for the solid set: 24% entry by luck for a question at 75% (0.75⁵), against 18% for the second round, which also costs nothing extra for a question that fails early.

**Evidence.** Baseline (commit `8bf30c0`, taken on `b0fb213`, prompt `1d555744`): 24, 26, 26 passes, tolerance 2; 8.6 cents a trial, margin 1.06 cents; 24 solid questions, all 24 entrants passing the second round's three runs (72 runs, 18.2 cents). Simulated on that baseline, rule 2 turns unchanged code red 4.5% of the time against 14.8% under the one-round entry, and the gate as a whole about one run in nine against one in five; red again on one re-run about one in twenty-five ([F27](facts.md#f27-on-unchanged-code-the-gate-is-red-about-one-run-in-nine-and-red-twice-about-one-in-twenty-five), `npm run simulate-gate`, [the experiment](../eval/experiments/2026-10-13-solid-six.md)). The previous baseline (commit `268529c`), under the one-round entry, was 25, 26, 26 with tolerance 1, 8.9 cents with margin 0.73, 25 solid questions.

**Revised.** The first estimate said one in a hundred after a re-run: it treated the re-run as independent, when both runs face the same solid set.

**Revised.** The first version of rule 2 held every question that passed the three accept trials. Three draws proved too cheap an entry: on 13 Oct a pull request that changed only documentation, so the agent was identical to `main`'s, went red under rule 2 twice before merging, each time on a different solid question. In [CI run 38314893054](https://github.com/MaximeLas/dave-io-takehome/actions/runs/38314893054) "Which instances would a deploy to the auto scaling group hit?" passed 1 of 3; in [run 38319345402](https://github.com/MaximeLas/dave-io-takehome/actions/runs/38319345402) "Do any GitHub workflows deploy directly to a database?" passed 1 of 3, two of its trials listing the eight deploy workflows they had checked as the answer to a question whose answer is none. Each re-run went green (the second at 25, 25, 26). The solid set is now earned over six draws, which cuts a lucky entry for a question at 75% from 42% to 18%. Six draws reduce lucky entries without ending them: a question at 85% still enters about four times in ten (0.85⁶ ≈ 0.38). The direct fix for the padding on empty-answer questions is a change to the agent, for the improvement loop, not to the gate.

**What would change it.** Reds on unchanged code well above that rate, or the paired per-question comparison of the next steps.

### Why does the baseline move only on purpose, and not after every green run?

**Choice.** The baseline is the benchmark declared working. It is retaken by `npm run eval -- --accept`, in its own commit, for a gain worth protecting (questions newly solid, a lower cost) or for a red run the team decides to ship, the commit stating the trade. A change within the allowances ships on the baseline it was judged against.

**Revised.** The first rule retook the baseline after every change that affects answers (applied once, commit `5a34d8e`). Under the three-trial gate it proved a ratchet: one change drops a solid question to two of three, which rule 2 allows, and the accept marks it not solid; the next drops it to none of three, a mean fall of two thirds of a question, inside rule 1's tolerance. With the baseline held, the second change fails rule 2. Commit `0f202de` corrected the rule.

**Rejected.**

- Following every green CI run, or retaking after every change: the same ratchet, with or without a person typing the command.
- A retake for cost headroom: it resets the margin and hides the cumulative drift a later red run would expose.
- A scheduled retake: a calendar in place of a reason.

**Evidence.** Meaning search shipped under the corrected rule with no accept: 25, 25, 26 at $0.091 a trial, against the baseline's 25, 26, 26 at $0.089 and its 9.7-cent ceiling ([meaning search](../eval/experiments/2026-10-12-meaning-search.md)). The next retake (commit `8bf30c0`) came from a change to the gate, not to the agent: the solid set is now earned over two accept rounds, and the gate refuses a baseline in the one-round format ([the experiment](../eval/experiments/2026-10-13-solid-six.md)).

**What would change it.** A provider-side change under the same model id shifting every run, which calls for re-declaring the benchmark with the cause stated.

## The server

### Why a multi-turn chat on the same entry point, with memory that does not survive a restart?

**Choice.** The server keeps one conversation per thread id in LangGraph's in-memory checkpointer, through the same `runAgent` the eval calls ([F10](facts.md#f10-conversations-a-checkpointer-a-thread-id-and-a-result-that-holds-the-whole-thread)). The eval passes no thread, so every question starts fresh. Each turn returns the structured answer the eval scores and saves a record of that turn alone; the page shows the prose, the ids as tags, and the turn's queries, cost and time.

**Rejected.**

- One question per request, with no memory: simpler, but not a chat; a follow-up such as "and which of those are in prod?" would need the user to restate everything.
- A persistent conversation store: nothing here requires conversations to survive a restart, and it is a swap of the checkpointer when something does.
- A separate explanation field in the answer: the prose already says what was checked, and the trace is the evidence.

**Evidence.** The agent returns the whole thread, so a turn's record would have re-counted every earlier turn's calls and tokens; it now starts at its own question (commit `e77f66a`, tested in `src/agent/run.test.ts`). The eval held: 24 of 30 in one run against 24, 25, 25 before, on prompt `1f77e706`.

**What would change it.** More than one server instance, or users needing a conversation after a restart: a persistent checkpointer. Follow-up turns are not evaluated today; follow-ups measured ending in prose, or answering from earlier rows on a graph that changes, would call for the multi-turn set of the next steps.
