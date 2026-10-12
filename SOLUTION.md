# Solution

How the assignment in `README.md` was answered: the agent, how it is measured, what the gate guarantees, what is known to be wrong, next steps, and the decisions behind it. The code was built with Claude Code, under the conventions in `AGENTS.md`.

**In brief**

- A chat over the infrastructure graph in Neo4j: one `deepagents` agent with a read-only Cypher tool and a vector search over the node descriptions, behind a NestJS server and a chat page. The chat and the eval call the same entry point, so what is scored is what ships.
- Claude Haiku 5.5 at effort high ships. The committed baseline passes 25, 26 and 26 of the thirty questions over three trials (12 Oct, prompt `1d555744`) at about 9 cents a trial. Sonnet 5.5, measured on 11 Oct on the earlier prompt over three runs each, scored one to three questions lower on every run at ten times the cost, and stays an option in the chat.
- CI runs three trials on every pull request and push to `main` and holds them to three rules against the baseline: the mean, the questions that always passed, and the cost. A drop fails the build; a green run never moves the baseline.
- Three questions fail on every run, where the key reads a question in a way no general convention would and no line was written for one question; three more wobble between runs, one of them at 0 of 3 in the baseline.
- Next: the improvement loop (a judge on failing traces, a person picking one change, the eval measuring it), the production loop that grows the benchmark from real use, and a held-out reworded question set.

**Contents**

1. [What this is](#what-this-is): what runs, and what `npm run eval` prints
2. [How this was built](#how-this-was-built): the rules, the facts ledger, the experiment files, the fingerprint, where to read
3. [How the agent works](#how-the-agent-works): the tools, the conventions, the answer, the model
4. [Retrieval](#retrieval-the-graph-first-meaning-search-beside-it): the vector index and what it was measured against
5. [The eval, as error analysis](#the-eval-as-error-analysis): the scoring, the metrics, the four changes, how much rests on the key
6. [The gate](#the-gate-what-it-guarantees-and-what-it-does-not): the three rules, the allowances, unlucky draws, gate versus accept
7. [Known misses](#known-misses): including the two traps the README names
8. [Current limitations](#current-limitations)
9. [How I would take this further](#how-i-would-take-this-further)
10. [Decisions](#decisions)

To run it (details in [`AGENTS.md` § Running it](AGENTS.md#running-it)):

1. Clone the repository and `npm install` (Node 22.9 or later, as `package.json` declares; CI runs Node 22)
2. Copy `.env.example` to `.env` and set `APP_ANTHROPIC_API_KEY`, the one secret; the Neo4j settings it lists match `docker-compose.yml`
3. `docker compose up -d --build`
4. `npm run index`
5. `npm run serve` for the chat, or `npm run eval` for the thirty questions

`npm run eval -- --help` lists the flags, and `npm run ask -- --list` prints every question with its id.

## What this is

- A chat page and a NestJS server (`web/`, `src/server/`) in front of one `deepagents` agent (`src/agent/`) with two tools: `run_cypher`, a read-only Cypher query tool, and `search_descriptions`, a vector search over the node descriptions.
- The eval (`eval/`) runs the thirty questions three times each on every pull request and push to `main`, and fails the build when the run falls below a committed baseline.
- The server and the eval call one entry point, `runAgent` in `src/agent/run.ts`, which writes a run record (tool calls, tokens, cost, answer, the prompt's hash, a fingerprint of everything the model reads, the commit) that `run.html?id=<runId>` lays out.

What `npm run eval` does:

- It checks that the graph is seeded and indexed, then runs three trials of the thirty questions, fifteen agent runs at a time (`eval/harness.ts`).
- It prints one row per question: passes out of trials, the expected id count, recall, precision, time, cost and tool calls, with the missing and extra ids under any failed trial.
- A summary block follows, then the path of the record saved under `runs/eval/` and a link to the first failing trace.
- The last line is the gate's verdict, the same check CI runs. The exit code carries it: 0 held, 1 regression, 2 the run cannot vouch for the agent.

A one-trial run, abridged (`npm run eval -- --trials 1`, 12 Oct):

```
command     npm run eval -- --trials 1
model       claude-haiku-5-5, effort high
version     prompt 1d555744, code 4ccca58
trials      1

passed      passes out of trials; a trial is one run of every question, and the gate runs 3
exp         ids the answer key expects
the rest    means per answered run: recall, precision, time, cost, tool calls
err, cut    beside the tool calls, only when nonzero: Cypher errors, results cut short

question                             passed  exp  recall  prec  time  cost  tool calls
dlq-for-prod-2                       1/1       1    100%  100%    8s  0.1c  3
prod-checkout-resources              1/1      16    100%  100%   20s  0.5c  5, 1 cut
storefront-resources                 0/1      13     62%  100%   14s  0.2c  3
  trial 1 failed: missing aws:s3:bucket-commerce-prod-1, aws:s3:bucket-commerce-prod-2, aws:s3:bucket-commerce-prod-3, datadog:monitor:commerce-1, datadog:monitor:commerce-2

passed      25 of 30
cost        8.1c
recall      94%
precision   95%
tool calls  160 (Cypher errors 2; cut results 3)
empty       0 answers without a final_answer call
wall clock  87s

------------------------------------------------------------------------
REPORTED only: 1 trial; the gate compares a 3-trial run with the baseline (npm run eval with no flags)
```

A three-trial run also prints the baseline's count beside each row and a gate block, one line per rule opening with `held` or `FAILED`, and ends on `OK: all three rules held` or `REGRESSION:` with the rules that failed.

## How this was built

The code was written by Claude agents, under rules I set, reviewed and enforced. The rules are the public [`AGENTS.md`](AGENTS.md): where code goes, how a tool is written, how a change to the agent is measured, how a commit reads. The eval decided every change to what the agent answers: a change stayed when its runs, at least three per side, showed a gain, or no loss for a piece the assignment requires.

Three records make that work checkable by someone who was not there:

- **A facts ledger, [`docs/facts.md`](docs/facts.md).** The agent stack (`deepagents`, LangChain, LangGraph) changes every few days, so an API recalled from memory is often stale. Each entry is one fact about the libraries, the graph or the answer key, a command a reader re-runs to verify it, the date it was last checked, and a stable id. The `F` citations in this document resolve there.
- **One experiment file per behavioural change, in [`eval/experiments/`](eval/experiments/README.md),** committed with the change: the failure pattern, the hypothesis, the runs before and after, what moved and what regressed. Its numbers are never edited afterwards; when later evidence overturns its reading, it gets one dated `Revised` line at the top ([`AGENTS.md` § Keeping these docs true](AGENTS.md#keeping-these-docs-true)).
- **A fingerprint in every run record.** It hashes everything the model reads (the prompt, each tool's name, description and input schema, the model id and its settings), so two records with the same fingerprint ran the same agent, and a score that moves between two fingerprints has a named cause.

Where to read, in order:

1. [`src/agent/run.ts`](src/agent/run.ts): the one entry point the eval and the server both call, and the run record it writes.
2. [`src/agent/prompt.ts`](src/agent/prompt.ts) and [`src/agent/conventions.ts`](src/agent/conventions.ts): the system prompt, and how the agent reads the words of a question on this estate.
3. [`src/agent/agent.ts`](src/agent/agent.ts): the model, the effort and the `final_answer` shape, in one place.
4. [`src/agent/tools.ts`](src/agent/tools.ts) and [`src/graph/query.ts`](src/graph/query.ts): the two tools, each described for a model that has never seen the system, and the read transaction, timeout and row cap behind every query.
5. [`src/search/vector-index.ts`](src/search/vector-index.ts) and [`src/search/search.ts`](src/search/search.ts): the vector index on the nodes, and how a search is ranked and cut.
6. [`eval/score.ts`](eval/score.ts): the grader, set arithmetic with no model and no database.
7. [`eval/baseline.ts`](eval/baseline.ts): the baseline and the gate's three rules.
8. [`eval/harness.ts`](eval/harness.ts): the questions through `runAgent`, three trials side by side, with infrastructure failures kept apart from wrong answers.
9. [`scripts/eval.ts`](scripts/eval.ts): the report and the exit code CI reads.
10. [`src/server/chat.service.ts`](src/server/chat.service.ts): one chat turn, on the same entry point.
11. [`.github/workflows/eval.yml`](.github/workflows/eval.yml): the gate in CI.

The method's limit is the eval's: it judges the agent on the thirty questions it was tuned against. What the agent still fails is in [Known misses](#known-misses); how it would score on questions it never saw is for the held-out set in [How I would take this further](#how-i-would-take-this-further) to answer.

## How the agent works

**The graph is the only source.** The model writes its own Cypher and reads the schema from the live database. Every query runs in a read transaction, so the database refuses any write ([F17](docs/facts.md#f17-a-read-mode-transaction-refuses-writes-on-the-server)).

**Of what `deepagents` adds beyond the tool loop, the agent uses only the loop:**

- **Planning:** this version offers Claude models no planning tool ([F3](docs/facts.md#f3-a-claude-agent-gets-no-write_todos-planning-tool-by-default)).
- **A filesystem:** cut to `read_file`, the one tool the library requires ([F6](docs/facts.md#f6-the-built-in-filesystem-tools-are-replaced-not-removed)).
- **Subagents:** the subagent tool, `task`, stays offered as the library ships it; removing it is a change to what the model reads, and no failure has asked for it.

Neither `task` nor `read_file` was called in any run recorded during development. Each would have to earn its place in the eval.

**The prompt.** The system prompt holds how to work, the answer contract, and reading conventions (`src/agent/conventions.ts`). The conventions are the briefing a new engineer gets before touching this estate, the same for any question, asked by the eval or not. They say what the words of a question mean here:

- an environment, read from a resource's name
- "reach", as permission rather than a network path
- "storage", as buckets and databases
- a business area, and what makes one up

Without them the model answers from its own defaults, and the traces showed where those differ from this estate's: it read "connect" as security-group rules and counted queues as storage.

How the conventions were written, to keep the briefing general rather than a patch per question:

- **The first set** was written by a separate Claude agent given only the live graph, never the questions, the key or any run, and asked for the reading guide it would hand a new hire.
- **Two of its readings disagreed with the key:** "reach" and "connect" as permission, and "storage" as buckets and databases. The key's reading was adopted after both were measured: 24, 25, 25 passes against 22, 21, 21 for the guide's own (three runs each, [conventions](eval/experiments/2026-10-11-conventions.md)).
- **The business-area lines** were written later from the failing traces, with one more reading taken from the key ([business area](eval/experiments/2026-10-12-business-area.md)).

Every set held one principle, stated in the header of `src/agent/conventions.ts`: each line is an assumption about the domain, never a fix for one question, so the readings generalise instead of fitting the eval. Lines that would have won specific questions were not written for that reason; [Known misses](#known-misses) names two. The text the model reads never mentions the eval; [the eval section](#the-eval-as-error-analysis) lists the three readings, since part of the score rests on them.

**The answer** is a `final_answer` call with two fields:

- `answer`: prose naming resources by id, with what was checked
- `ids`: only the resources that answer what was asked

An answer that ends in prose without the call is recorded as empty and fails.

**Model.** Claude Haiku 5.5 at effort high ships. The choice was measured on 11 Oct on the prompt then shipping (`1f77e706`), with full runs of each model at the same effort ([shipped model](eval/experiments/2026-10-11-shipped-model.md)):

- **Passes:** Sonnet 5.5 passed 22, 23 and 23 of 30, Haiku 24, 25 and 25 (24 on a fourth run). The difference is inside the run-to-run noise of about two passes.
- **Misses:** both models missed the same four questions.
- **Prose endings:** Sonnet ended 2, 2 and 3 answers in 30 in prose instead of calling `final_answer`, often with the right answer in the prose; Haiku never did.
- **Cost:** Haiku cost about a tenth, 11 to 12 cents per run of thirty questions, against $1.09 to $1.40 for Sonnet.

What separated the two was mostly the answer contract, not capability. At a tenth of the cost, with one model for CI to gate, Haiku ships and the chat keeps Sonnet as an option. In the current baseline's 90 runs (12 Oct, prompt `1d555744`), a question costs about 0.3 cents and takes about 11 seconds at the median (from the local run records; the baseline file holds no durations), against 9 to 10 seconds for Sonnet on 11 Oct: Haiku is cheaper and slower.

What was not measured, and what is not wired:

- **No other model and no other effort was measured.** A cheaper model or a lower effort may do as well, which is [a next step](#how-i-would-take-this-further).
- **Only Anthropic models are wired.** The answer contract and the effort setting are shaped for them ([F1](docs/facts.md#f1-structured-output-toolstrategy-with-the-tool-choice-left-to-the-model), [F12](docs/facts.md#f12-the-current-models-take-no-sampling-parameters-effort-is-the-one-output-knob)), and another provider would need its own adapter.

## Retrieval: the graph first, meaning search beside it

`npm run index` embeds each node's description and stores the vector on the node:

- **The model:** `all-MiniLM-L6-v2`, run locally and pinned to one revision ([F26](docs/facts.md#f26-the-embedding-model-runs-locally-its-two-onnx-ports-give-the-same-vectors-to-six-decimals)).
- **The index:** a cosine vector index, queried with Neo4j's `SEARCH` clause ([F25](docs/facts.md#f25-vector-search-on-this-server-the-search-clause-integer-dimensions-and-scores-of-1--cos--2)).
- **Coverage, not freshness:** the eval and the server refuse to start unless every node has a vector of the right size (`src/graph/health.ts`). A description edited after indexing keeps its old vector and passes that check, so a changed description needs `npm run index` again; CI rebuilds the index on every run.

**Measured offline first.** The search was measured before the agent was touched, on 22 phrases (19 with a relevant description) written and labelled by Claude Opus 5.5 from the 79 descriptions alone, never the questions or the key ([meaning search](eval/experiments/2026-10-12-meaning-search.md)). On that set:

- **Against Neo4j's full-text index,** vectors win (mean average precision, MAP, 74% against 40%; 100% would rank every relevant description first), and the lead is on wording: 60% against 25% on paraphrases, level at 82% when the phrase uses the descriptions' words.
- **Against the agent's own method,** guessing words for a `CONTAINS` filter, vectors do not win, because the descriptions use a small vocabulary a model guesses well.
- **Combined with the word lists of two Haiku 5.5 writers,** the relevant descriptions never found fall from 20% to 9% and from 12% to 7%.

So the tool ships as a complement to the word guessing, not a replacement. Rejected on the same set:

- **A fixed score threshold,** which found less than the top 10 (recall 75% against 81%), because scores are not comparable from one phrase to the next.
- **Embedding the name with the description,** which added nothing (MAP 71%).

**On the eval,** the revised tool held the score and the cost, as the hypothesis written before the run said:

- **Score and cost:** three trials passed 25, 25, 26 at 9.1 cents a trial, against the baseline's 25, 26, 26 at 8.9 cents, the same within noise.
- **Where the search was called:** in both local runs, on the same 8 questions, each naming a purpose, and on none that the graph's structure answers, with no line in the prompt asking it to.

## The eval, as error analysis

How a question is scored:

- **Exact match:** a question passes when the asserted ids equal the key's exactly.
- **Named ids are neutral:** ids the question itself names count neither way, since the key includes them in one of the ten questions that name a resource ([F21](docs/facts.md#f21-the-answer-key-is-generated-by-a-script-outside-this-repository)).
- **Empty fails:** an empty answer never passes, because no answer is not an answer of "none".

`npm test`, which CI runs first, checks the grader itself: the key scored against itself passes every question, an empty answer fails every one, and the gate returns each of its verdicts.

**The metrics.** The README calls the key a reference, not the whole rubric, and asks what else is worth measuring. Three tiers:

- **Gated today:** the pass count, by rules 1 and 2, and the cost per trial, by rule 3 ([the gate](#the-gate-what-it-guarantees-and-what-it-does-not)).
- **Reported, not gated:**
  - recall and precision, which say how a failing answer failed: an expected id missing, or one too many;
  - empty answers, the runs that broke the answer contract;
  - tool calls, Cypher errors and cut results (query results over the 100-row cap), which show how much work an answer took and how well its queries were written;
  - duration.

  Every run prints them; a three-trial run also prints the mean recall, tool calls, Cypher errors and empty answers beside the baseline's (`scripts/eval.ts`). They have earned their place: recall of about 90% against precision of 61 to 74% is what pointed to the first change below. A reported metric becomes a gate once it is steady across runs and has an agreed budget ([`AGENTS.md` § Scoring](AGENTS.md#scoring)).
- **Not measured yet:** what the thirty cannot show. They are single turns of well-meant input in one wording, scored on `ids`, not on the prose the user reads. A held-out reworded set, a multi-turn set, an adversarial set and a judge for the prose would cover those (items 2 and 3 of [How I would take this further](#how-i-would-take-this-further)).

**Why the harness is hand-built.** The README allows any framework, but the score is a set equality on ids, the gate is three rules over a JSON baseline committed in git, and every run's full trace is already a local record the run page lays out, so a hosted tracer such as LangSmith or Braintrust would add a second key and a service for what `runs/` and `eval/baselines/` already hold. One would earn its place with a model judge, whose verdicts need annotation queues for a person's labels, or with dashboards over many runs.

Each change is written up in [`eval/experiments/`](eval/experiments/README.md), measured on Haiku 5.5 at effort high in local runs, three full runs per side unless the row says otherwise. Each row's before and after are the runs recorded in its own experiment file:

| Change | What the traces showed | Passed, before → after |
| --- | --- | --- |
| [The `ids` rule](eval/experiments/2026-10-11-ids-rule.md) | Recall about 90%, precision 61 to 74%: answers added the starting resource, the hops, or context | 13, 11, 10 → 20, 21, 21 |
| [Conventions](eval/experiments/2026-10-11-conventions.md) | Written by a Claude agent blind to the questions, then measured; the two readings that differed from the key's were replaced by the key's | 20, 21, 21 → 24, 25, 25 |
| [Business area](eval/experiments/2026-10-12-business-area.md) | The agent found an area's resources, then dropped them, modelling an area as a lane of compute | 25, 25, 25, 24 (four runs) → 27, 27, 24 |
| [Meaning search](eval/experiments/2026-10-12-meaning-search.md) | Not a failure: the required vector layer, hypothesis "no change" | 25, 26, 26 → 25, 25, 26 |

The agent did not change between the third row's "after" and the fourth row's "before": both are runs of the same prompt, and the gap between 27, 27, 24 and 25, 26, 26 is its run-to-run spread, 24 to 27 over the ten runs of the agent before meaning search. The fourth row's "before" is the committed baseline, taken on that prompt after the business-area runs.

**How much of the score rests on the key.** I am not on dave.io's team, so the only record of what its words mean on this estate (what "reach" means, what counts as storage, what makes up a business area) is its answer key. A new engineer learns the house vocabulary from the house's answers, and the conventions write that vocabulary down once, for every question. The key was generated by a script ([F21](docs/facts.md#f21-the-answer-key-is-generated-by-a-script-outside-this-repository)), so each expected set follows a rule; what I took from it is the rule, stated as a reading a person would give, never a line written to win one question. Where the key contradicted itself, I asked instead of guessing: on whether queues are data resources ([Known misses](#known-misses)). Three readings in the conventions were taken from the key:

- **"Reach" and "connect" as permission,** and **"storage" as buckets and databases:** measured together against the blind reading, 24, 25, 25 against 22, 21, 21 (above).
- **Which resource kinds make up a business area:** without it, the business-area prompt fell to 23, 24, 23 (three runs).

The business-area lines were also written from the failing traces. The variant that shipped was chosen on the eval from totals inside the noise (27, 27, 24 over 25, 26, 26), so its gain is not held-out evidence. Per question the gain is large:

- **"Which prod resources are related to checkout or order flow?"** went from 0 of 11 runs on the previous prompt to 3 of 3.
- **"Which resources are involved in fulfillment?"** went from 2 of 11 to 3 of 3.

Both have passed every local trial of the shipped prompt recorded since.

## The gate: what it guarantees and what it does not

The gate reads three trials (every question three times) against a baseline of three trials, and holds three rules, each a check for a drop (`eval/baseline.ts`, [`AGENTS.md` § Scoring](AGENTS.md#scoring)):

1. **The average:** the mean pass count may not fall by more than the pass tolerance.
2. **The solid set:** a question that passed all three baseline trials must pass at least two of three. Questions below three of three are reported, never gated.
3. **Cost:** the mean cost per trial may not rise by more than the cost margin.

The current baseline is [`eval/baselines/claude-haiku-5-5.high.json`](eval/baselines/claude-haiku-5-5.high.json), taken on 12 Oct on prompt `1d555744`, before meaning search:

- **Passes:** 25, 26, 26, with a tolerance of 1, so rule 1 fails at 73 passes or fewer over three trials (a mean of 24.3).
- **Cost:** 8.9 cents a trial with a margin of 0.73 cents, so rule 3 fails above 9.7 cents.
- **Solid set:** 25 questions.

In questions, against that baseline:

- **Caught:** a fall of more than one question on the mean.
- **Caught:** any solid question falling to one of three.
- **Let through:** a solid question falling to two of three passes both rules, though the report prints it beside the baseline.

**Where the allowances come from.** The gate has to know how much the score moves when nothing changes, so that it does not fail a change for noise. It measures that from the three accept trials:

- **Each allowance is the spread of the three accept trials,** highest minus lowest. On the current baseline the three pass counts were 25, 26, 26, so the tolerance is 1.
- **Each has a floor,** one pass for the tolerance and 5% of the mean cost for the margin, because three trials can agree by luck and an allowance of zero would fail the next run on any wobble.
- **Three draws underestimate the noise.** Across the ten runs of the agent before meaning search on this prompt (the business-area experiment and the two baseline commits, `5a34d8e` and `268529c`), the pass count ranged from 24 to 27, a spread of 3; the three accept trials happened to fall within 1. The tolerance is therefore tighter than the real wobble, which is why unchanged code can go red and the policy below says re-run once.

A tolerance from one accept is a simplicity trade. Rejected: a hand-set tolerance, which turns each accept into an argument instead of a measurement; and more accept trials, which cost more per accept and are [a next step](#how-i-would-take-this-further).

**Unlucky draws.** Rule 2 has no allowance, and a question that usually passes can enter the solid set by three lucky draws. So unchanged code turns the gate red about one run in nine, and about one in thirty is red again on one re-run, because the re-run is judged against the same baseline and a wobbly question that entered the solid set by luck is still in it (`npm run simulate-gate`, `scripts/simulate-gate.ts`: 100,000 simulated pairs of runs, seed 1, from the committed baseline's per-question passes out of three; red 11.0%, rule 2 7.7%, rule 3 3.6%, rule 1 never; red twice 3.3%). An earlier estimate, from pass rates pooled over ten local runs, also gave about one in ten, but one in a hundred after a re-run, because it treated the re-run as independent of the accept. Policy: re-run once, investigate red twice. The re-run has a price: a real drop also gets two attempts, so a solid question that fell to passing half the time clears rule 2 on one attempt about half the time and on one of two about three times in four. The re-run buys fewer false reds at the cost of slower detection of a wobble; a collapse is caught either way.

How close the rules sit, as observed:

- **Rule 2, in CI:** one such red occurred, on the first CI run of meaning search. "Do any GitHub workflows deploy directly to a database?" passed 1 of 3, a question that had passed 10 of 11 runs before and called no search ([meaning search](eval/experiments/2026-10-12-meaning-search.md)).
- **Rule 1, in a local run** (not in CI, so not in the public record): a three-trial run of the same agent on 12 Oct scored 24, 25, 25, exactly the floor of 74 passes. One fewer pass in any trial would have failed it.

The gate failing a real change is shown by closed pull request #2, a deliberate regression (the ids emptied) that went red with 2 passes on the earlier one-run gate. The three rules are covered by `eval/baseline.test.ts`.

**Gate and accept are two acts.**

- **The gate** checks every change against the baseline, the benchmark declared working.
- **`--accept`** re-declares the baseline, in its own commit, after a person has read the run: for a gain worth protecting, or for a red run shipped on purpose, the commit signing the trade.

Never after a neutral change: retaken after every change, a solid question that slips to two of three loses its protection, and the next change can lose it entirely within rule 1's tolerance, green both times. The rule was tightened to this once the three-trial gate made the ratchet visible. Meaning search shipped under it, with no accept (commit `0f202de`).

**Sources.** The gate draws on Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) and Evan Miller's [Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640) for the pattern: several trials per question, the spread reported. It compares unpaired means, which is simpler and weaker than Miller's paired per-question differences.

**In CI,** the 90 agent runs take about 100 seconds and 27 cents ([run 38269765485](https://github.com/MaximeLas/dave-io-takehome/actions/runs/38269765485), on `0f202de`: 26, 26, 26). A red run names the rule, and the `runs-attempt-<n>` artifact holds every trace. The eval is a required check on `main`, so a red pull request cannot be merged.

**Every record carries two identities,** next to each other:

- **A fingerprint** of everything the model reads (the prompt, each tool's name, description and schema, the model id and its settings), which answers whether the model saw the same thing.
- **The git commit,** which answers whether the code changed.

The pair identifies a run.

## Known misses

Three questions fail on every run, and no convention line was written to win them ([business area](eval/experiments/2026-10-12-business-area.md)):

- **"Which resources serve storefront or customer-facing traffic?"** The key counts the customer-latency monitors and the product buckets; the agent reads "serve traffic" literally.
- **"What should I inspect if fulfillment jobs are backing up?"** The key starts from the queues described as fulfillment work and adds the instances that can reach them; the agent lists the area's workers.
- **"The instances described as order-flow: which data resources do they actually have access to?"** The key counts four queues as data here and none in "Which production data resources have no monitoring?", though 14 of the 16 production queues have no monitor; dave.io confirmed queues are not data resources. This set is also the one exception to the key's area rule: production only, though no environment is named ([F22](docs/facts.md#f22-the-key-reads-reach-and-connect-as-permission-and-storage-and-data-as-buckets-and-databases-with-one-exception), [F23](docs/facts.md#f23-how-the-key-reads-a-business-area-by-the-resources-own-description-across-environments)).

The storefront miss could be won by a convention line written for that one question, which is the bias the conventions avoid. The fulfillment miss is different: the rule it needs is already in the conventions ("to find what uses, reaches or watches something, follow the graph from that resource, not from the compute you expect to use it"), and the agent does not apply it there.

The README names two traps among the questions ([README § Evaluation Harness](README.md#evaluation-harness) and the notes under it): some point one way in the descriptions and another in the graph, and at least one has an empty answer.

- **Descriptions against the graph:** "What should I inspect if fulfillment jobs are backing up?" is one. The instances described as fulfillment workers have no permission on the queues described as fulfillment work; four instances described as product-information hosts do. The key takes the queues from their descriptions and the instances from the graph ([F23](docs/facts.md#f23-how-the-key-reads-a-business-area-by-the-resources-own-description-across-environments)). The agent lists the workers, says in its prose that they cannot reach those queues, and fails on exact match: the second miss above, 0 of 3 in the baseline and in every local run of the shipped prompt. The conventions already say to follow the graph from the resource; why the agent does not here is a hypothesis, not a measurement: the question names an area, so the area rule fires first and the agent never starts from the queues.
- **Empty answers:** two questions expect none, "Do any GitHub workflows deploy directly to a database?" and "Can any dev compute instance reach production storage?" (`eval/expected.generated.json`). The answer contract asks for an empty `ids` with what was checked in the prose, which passes; an answer with no `final_answer` call fails, because no answer is not an answer of "none". Both passed all three baseline trials; the workflows question still wobbles, as below.

Three questions wobble, each by naming the right resources in the prose and putting one too many or one too few in `ids`:

- **"What is the compute stack in my dev env?"** passed about four runs in ten on the shipped prompt when the baseline was taken, and 0 of 3 in it (commit `268529c`). The misses leave out the dev load balancer and its target groups.
- **"Which repository's code ends up on i-ecomm-dev-02?"** passed 10 of 11 runs on the earlier prompt ([F24](docs/facts.md#f24-four-questions-failed-on-every-run-of-prompt-1f77e706-and-four-more-on-some-runs)), 2 of 3 at accept, and 0 of 3 in the local run that sat on rule 1's floor, each time adding the deploy workflow.
- **"Do any GitHub workflows deploy directly to a database?"** is in the solid set at three of three, yet it failed 2 of 3 trials in meaning search's first CI run and 2 of 7 local trials of the same agent on 12 Oct after the merge. In both local failures the prose answered no, correctly, naming the workflows it checked; the slip is in `ids`, where it listed the deploy workflows it had ruled out, against a key that expects none. The solid set is a sample of three, not a guarantee.

The thirty questions cannot test follow-up turns or adversarial input. With three readings taken from the key, the score is also partly fitted to it.

## Current limitations

What is not ready for production, and what was planned and not built:

- **No input guard.** A guard against prompt injection, off-topic and harmful input was planned early and never built ([item 3 of the next steps](#how-i-would-take-this-further)). Today only the read transaction and the query timeout stand between a user's message and the database, and no layer refuses a request: whether an off-topic or hostile message gets an answer is left to the model.
- **Follow-up turns are not evaluated.** The eval runs each question on a fresh thread (decision 4), so nothing checks that a second turn in a conversation still ends in a `final_answer` call whose `ids` answer that turn. A turn that ends in prose reaches the chat as prose, and how often a follow-up does is unmeasured.
- **The server:**
  - listens on localhost only, with no login, and no dollar cap or rate limit;
  - bounds each turn by a 120-second deadline, 16,000 output tokens per model call and a 30-second query timeout, and the chat never offers Opus;
  - keeps conversations in memory, so they are lost on restart (a forgotten one answers 404), and the thread id is the only key to one;
  - checks the graph at startup only.
- **The false-red figures rest on three draws per question.** `npm run simulate-gate` reads each question's pass rate from the committed baseline, so a question at 3 of 3 is modelled as never failing and the rule 2 figure is a floor; "Do any GitHub workflows deploy directly to a database?" was such a question and still broke rule 2 in CI. Pooled over the eleven local eval records of the shipped prompt (`--runs`; not committed, and spanning the agent before and after meaning search), the same command gives about one run in five red and one in fourteen red twice.
- **No failing trace is linked.** Run records are not committed and a CI run's artifact expires, so the error analysis above is told through the experiment files, with no trace a reader can open.
- **CI** runs a pull request against GitHub's merge commit, so its record names a temporary commit; runs on `main` record real ones. A fork's pull request gets no API key and ends INCOMPLETE.
- **Local embeddings** avoid a second key at the price of about 290 MB of native packages.

## How I would take this further

Two loops first: one that improves the agent from its failing traces, one that grows the eval from real use. Then the sets the thirty questions cannot stand in for, the gate's statistics, and smaller changes, each measured on the eval as the four changes above were.

1. **The improvement loop.** Today a failing question is diagnosed by reading its trace by hand, which is how the business-area failure was found (the agent found an area's resources, then dropped them). The loop makes that diagnosis repeatable, in five steps:
   1. **Re-derive the key.** A Claude agent on a larger model than the one that ships re-derives every question's answer from the graph and records where the key is wrong, or is one reading among several. The key itself is never edited: amendments live in an overlay, each with its reason and evidence, and the score is reported against both. The three known misses are where it would start.
   2. **A reference file** holding the reasoning and the evidence behind each answer.
   3. **A judge** that reads one failing trace against that reference and names where the reasoning went wrong, such as a shortcut or a wrong scope. It is validated on hand-labelled traces before anyone relies on it, and it never gates.
   4. **An aggregator** that reads the judge's reports and proposes one change to the prompt, the tools, the model or the effort. A person picks it, and the eval measures it like any other change. The more of the loop is automated, the more it needs questions it never optimised on, which is the held-out set in item 3.
   5. **A flag** that runs the loop on demand, and optionally in CI.

   Its interface is a workbench page that lays out everything the model reads (what the fingerprint hashes), lets a person change one thing without saving, runs the thirty against the baseline, and hands a failing trace to the judge.

2. **The production loop.** Every chat turn already saves its full trace under `runs/`, with its cost, duration, tool calls and whether it ended without an answer. Each week I would sample those traces, note the first error in each, group the notes into failure modes and count them: the error analysis of the eval section, run on real use. Each new failure mode becomes an eval question, so the benchmark grows from what users ask instead of staying the thirty questions handed over.

   A model judge enters only for a failure mode that code cannot check. The first candidate is whether the prose agrees with the `ids`: code can check that every id in `ids` appears in the prose, but not whether the prose asserts the same set, since it also names what was ruled out (decision 3). Any judge is checked against a person's labels before it gates.

3. **The eval's blind spots.** The thirty questions test one wording of each question, single turns and well-meant input. Four additions would cover the rest, each with its own labelled set:
   - **A held-out reworded set:** the same intents in words the agent never saw, with its own key, never used to choose a change. It answers "what would this agent score on questions it never saw", which the thirty cannot, since three readings were taken from their key. It is also where a gain in robustness to wording would show, such as the search's lead on paraphrases in the offline measurement; the thirty could not show it.
   - **A multi-turn set** checking the answer contract on follow-up turns: a second question that leans on the first ("and which of those are in prod?") still ends in a `final_answer` call whose `ids` answer it.
   - **An adversarial set** of injection, off-topic and harmful input, behind a cheap first-pass classifier that can be switched off in development. The set is read both ways: what the guard lets through, and which of the thirty it wrongly refuses.
   - **An answer-quality judge** for the prose the user reads, whose priority depends on who the user is: an engineer reading ids needs less from the prose than an external user. Its verdict is binary on each of three criteria: it answers the question asked, in the form that user needs, and names what was checked. Its false passes and false fails are measured against a person's labels before it gates anything.

4. **The gate's statistics.** Three changes to what the gate can see:
   - **A paired comparison.** Compare each question with its own baseline count and count the questions that flipped each way, instead of comparing two means. A hard question is hard on both sides, so question-to-question difficulty cancels and the same ninety runs detect a smaller change; this is Evan Miller's recommendation, cited in the gate section.
   - **A stricter entry to the solid set.** A question would earn it by passing every trial of two accept rounds in a row instead of one, six draws instead of three. For a question that passes 75% of the time, with independent trials, the chance of entering by luck falls from 42% to 18% (0.75³ against 0.75⁶); five trials at one accept, the option decision 8 deferred, would give 24%. The second round runs only the questions that passed the first, each stopped at its first failure, so a stable question costs at most three more runs and an unstable one nothing extra: at most 75 runs, about 22 cents, for the current baseline's 25 solid questions at 0.3 cents a run. The mean and the cost would still come from the three full trials.
   - **The cost rule over the solid questions only.** In the baseline's 90 runs (12 Oct, prompt `1d555744`, from the local run records), the five questions outside the solid set cost about 0.48 cents each, against 0.26 for the solid ones. Rule 3 over all thirty therefore mixes a change in what answers cost with a change in which questions pass, which rules 1 and 2 already judge; over the solid set it asks only whether the same answers got more expensive, with the others' cost reported beside it.

5. **Smaller changes**, one line each, each measured on the same eval:
   - **A cheaper model or a lower effort**, each against its own baseline; the eval already takes `--model` and `--effort`.
   - **Other providers** behind an adapter for the answer contract and the effort setting.
   - **CI skipping the eval for documentation-only changes**, by a list of what the agent and the eval read rather than a filter on Markdown (the questions are Markdown), and never on the fingerprint alone, which covers what the model reads and not what the tools do.
   - **Neighbour expansion on search hits**, as Neo4j's `VectorCypherRetriever` does with a retrieval query run after the vector search, if traces show search-then-walk costing steps.

## Decisions

Written down as the work went, published here at the end: the context, the choice, what was rejected.

1. **One package, one entry point.** An eval protects production only if it scores what production runs. Rejected: a multi-package workspace, worth it only with several teams or deployables.
2. **One generic read-only query tool first.** The model writes working Cypher (2, 2 and 6 errors in 168 to 178 tool calls across the baseline's three trials), and no failure so far asks for a specific tool. Rejected:
   - specific tools first, which cover only what was foreseen
   - a keyword filter as the guard, which is brittle
   - a read-only user, which Community does not offer
3. **One structured answer for the chat and the eval.** Prose names ids it ruled out, so the claim must be separate from the explanation. Rejected:
   - searching the prose for ids
   - a second model call to extract them
   - an eval-only format
   - a retry on prose endings, which hides what the prompt should fix
4. **A multi-turn chat on the same entry point**, with LangGraph's in-memory checkpointer; the eval passes no thread, so every question starts fresh. Rejected:
   - stateless requests
   - a persistent store, a one-line swap when needed
5. **Queues are not data resources.** Rejected: counting queues, which fails the other question.
6. **The eval gates every pull request and push to `main`.** Rejected:
   - path filters, since a change to the questions could skip the eval
   - testing the pull request's head instead of the merge result
   - editing the provided compose file
7. **The baseline follows the agent that ships**, retaken after every change. Reversed by decision 9: retaking after every change ratchets.
8. **Three trials, three rules.** One run against one stored run needed a tolerance of 3, letting three solid questions go, and cost was ungated. Rejected:
   - a baseline that follows green runs, which ratchets
   - hand-set allowances, an argument at each accept
   - a cost rule that relaxes when the score rises, which needs an exchange rate between cents and questions
   - five accept trials for now, a bigger build (item 4 of the next steps above)
9. **The baseline moves on a gain or a signed trade.** Rejected:
   - a retake for cost headroom, which hides cumulative drift
   - a scheduled retake, a calendar in place of a reason
