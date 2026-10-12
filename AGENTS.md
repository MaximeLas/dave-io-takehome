# AGENTS.md

Infrastructure knowledge chat: a NestJS backend runs a `deepagents` agent that answers questions about the mock infrastructure graph in Neo4j, combining graph traversal with vector search over node descriptions. An eval harness scores the agent on 30 fixed questions in CI and fails the build on a regression.

The assignment is `README.md`; the specification of what the agent must answer is `eval/QUESTIONS.md`. How it was answered, with the decisions, the measurements and what is known to be wrong, is `SOLUTION.md`.

## Where code goes

One npm package. Each piece of the system gets its own folder, created with its first file:

| Folder | Holds |
| --- | --- |
| `src/graph/` | Neo4j access: the driver and the queries the tools run |
| `src/search/` | the vector index over node descriptions, and the script that builds it |
| `src/agent/` | the agent: model, tools, system prompt |
| `src/server/` | the NestJS app that exposes the agent to the chat UI |
| `web/` | the chat UI |
| `eval/` | the questions, the expected answers, and the harness that scores the agent; the audit of the key (`key-audit.md`) and its amendments (`key-overlay.json`); the labelled search phrases that measure retrieval on its own |
| `scripts/` | developer commands run with `tsx` |
| `runs/` | one JSON record per agent run (question, tool calls, tokens, cost, answer); gitignored |

Helpers that belong to no piece (`src/env.ts`, reading settings) stay at `src/`.

The eval harness and the server call the same agent entry point, `runAgent` in `src/agent/run.ts`, so what is scored is exactly what ships. It returns the run record that `runs/` stores.

**The assignment files are read-only:** `README.md`, `eval/QUESTIONS.md`, `eval/expected.generated.json`, `mock-infra.cypher`, `docker-compose.yml` and `Dockerfile` stay exactly as received. Our work goes in new files beside them.

## Running it

- Neo4j: `docker compose up -d --build` from the repo root (the README's `cd` step does not apply here). The seed loads 297 nodes and 579 relationships.
- `npm run index` once the graph is seeded: it embeds every node's description with a local model (downloaded on first use, about 90 MB) and builds the vector index the search reads. Run it again after re-seeding or changing the model; the index's name carries the model id, so a stale index reads as missing.
- `npm run check` before anything else: it checks the API key works, the agent library loads, and the graph is fully seeded and indexed, without spending model tokens.
- `npx tsx --env-file-if-exists=.env scripts/measure-search.ts` measures retrieval without the agent: it ranks the descriptions for each phrase in `eval/search-dev-set.json` (written blind to the eval's questions) by vectors and by Neo4j's full-text index, scores the agent-style word lists in `eval/search-word-lists.json`, and compares cutoffs. It writes a temporary full-text index, so run it on a database no one else is measuring.
- `npm run ask -- <question-id | question text>` runs the agent on one question (an id from `eval/QUESTIONS.md`, or any text), prints every tool call and the answer with its cost, and saves the record under `runs/`. `--list` prints every question with its id; `--help` lists the options. `--model <id>` and `--effort <level>` override what ships; comparisons between models set the effort explicitly, because the API's default effort differs by model.
- `npm run eval` checks the graph is seeded and indexed, runs the thirty questions through the agent as it ships three times each (three trials, side by side, about 27 cents), scores each against the key, prints one row per question with its passes out of three and its diagnostics, saves the eval record under `runs/eval/`, and compares the run with the committed baseline for that model and effort (`eval/baselines/`) under the three rules of § Scoring. For the questions `eval/key-overlay.json` amends, each row and the totals also print the passes against the amended key, which nothing gates. Exit code: 0 when the baseline holds, 1 on a regression, 2 when the run cannot vouch for the agent (the graph was not ready, a question threw or timed out, or the configuration has no baseline in the current format), 3 on a usage error; only 0 ships. `--trials 1` is a quick read, reported and not compared; `--model` and `--effort` compare another configuration against its own baseline; `--only <ids>` runs a subset, reported and not compared; `--accept` declares the run the new baseline, both allowances measured from it; `--help` lists the options and how each run is judged.
- `npm run simulate-gate` estimates how often the gate turns red on unchanged code, and red again on one re-run: it draws pairs of three-trial runs (an accept, then a later run) from the committed baseline's per-question passes out of three, judges each with the gate's own code, and prints each rule's share with the seed and the number of pairs, so the figures repeat exactly. No model call, no database; `--runs <dir>` pools local eval records for finer pass rates, `--help` lists the options.
- CI (`.github/workflows/eval.yml`) runs the typecheck, the tests and `npm run eval` on every pull request and every push to `main`, against Neo4j started from `docker-compose.yml` with the description index built, and only a green run ships. A red run names the step that failed; when it is the eval, the run page's summary shows the per-question table and ends on the verdict (`REGRESSION`, `INCOMPLETE`, or no baseline), and the `runs-attempt-<n>` artifact holds every question's trace, which `run.html?id=<runId>` lays out once its files are copied into a local `runs/`.
- `npm run serve` compiles the server and, once the graph is seeded and indexed, starts it at http://localhost:3000, on localhost only (`HOST` and `PORT` override): the chat page, `POST /api/chat` (one turn; shapes and rules in `src/server/chat.service.ts`), and `GET /api/runs/<runId>`, which `run.html?id=<runId>` lays out for reading, an eval question's record too. A caller sends back a reply's `threadId` to continue the conversation; a conversation keeps the model it started with and lives in the server's memory. Every turn saves its run record under `runs/`.
- `npm test` runs the tests without a model or a database: the key scored against itself passes every question, an empty answer fails every question, each of the gate's three rules holding and failing, a baseline taken from three trials, an old-format baseline refused, an error in one trial making the run incomplete, a key overlay replacing only the questions it names and leaving the gate's verdict unchanged, the false-red simulation matching a hand calculation and repeating exactly for a seed, a vector printed by its length in a query result, a search reply that says what it left out, a chat turn's record counting only its own messages, the agent version moving with a tool's text or the effort and not with the tools' order, the chat endpoint's validation and JSON-only body, and a missing setting named as such rather than read as a database outage. Run it before trusting any score.
- Settings come from `.env`; `.env.example` lists every variable. A new variable goes into both.
- The Anthropic key is `APP_ANTHROPIC_API_KEY`, not the SDK's default name, so the agent builds its model explicitly with that key (see `docs/facts.md`).

## Library facts

The agent stack (`deepagents`, `langchain`, LangGraph) changes every few days, so recalled API knowledge is often stale. Before relying on an API from memory, check `docs/facts.md`; when you establish a new fact, add it there with a command that re-verifies it.

Where to look, in order:

1. `docs/facts.md`, the facts already verified for our pinned versions.
2. The installed package: `node_modules/<pkg>/README.md` and its `dist/*.d.ts` type definitions. These match the pinned version exactly.
3. LangChain's official docs, which cover deepagents JS: https://docs.langchain.com/oss/javascript/deepagents/overview (also served over MCP at `https://docs.langchain.com/mcp`).
4. Context7, library id `/langchain-ai/deepagentsjs`.

LangChain's `langchain-skills` pack was reviewed on 2026-10-08 and trails our pinned deepagents version; the sources above take precedence.

## Changing the agent

- Start from the smallest version that answers a question end to end, then make one change at a time and measure each with the eval. The score, per question and overall, decides whether a change stays.
- Added machinery (a new tool, a subagent, a second model call) earns its place by a measured gain in correctness, cost or speed.
- Read the agent's trace (its plan, tool calls and their results) when a question fails; the score says that it failed, the trace says why.
- A change that affects what the agent answers adds its file to `eval/experiments/` in the same commit (the folder's README says what an entry holds and how a change is measured): the failure pattern it targets, the hypothesis, the runs before and after, what moved and what regressed.
- The model id lives in one place in `src/agent/`. Changing it, or upgrading a dependency, is its own commit with an eval run, so a score change can be attributed.
- The system prompt is one string whose hash goes into every run record, so a prompt change is attributable like a code change; beside it, the agent version hashes everything the model reads (the prompt, each tool's name, description and input schema, the model id and its settings), so two records with the same agent version ran the same agent. The record also carries the git commit the code ran from (`-dirty` when uncommitted), since the model reads the tools' text too.
- The answer is structured (`answer` prose for the user, `ids` for the eval), delivered by the model through a `final_answer` tool. One shape serves the chat and the eval, so what is scored is what the user reads; an eval-only answer format would score something that never ships.

## Scoring

- A question passes when the ids the answer asserts equal the expected ids exactly; the ids the question itself names count neither way, because the key includes them in one question of the ten that name a resource (`docs/facts.md`). An empty answer (no `final_answer` call) never passes, even when the expected set is empty: no answer is not an answer of "none".
- The gate scores against the key as received, the reviewers' reference. Where `eval/key-audit.md` re-derives an answer from the graph and finds the key wrong, `eval/key-overlay.json` holds the amended set with its reason; the eval reports the score against the amended key beside the key's, and the key file is never edited.
- The model samples, so the same agent scores differently from run to run. The gate therefore reads three trials (every question run three times) against a baseline taken from three trials, and holds three rules, each a check for a drop: (1) the average pass count may not fall by more than the pass tolerance; (2) a question that passed all three baseline trials must pass at least two of three, while questions below three of three are reported next to their baseline count and never gated; (3) the average cost per trial may not exceed the baseline's by more than the cost margin. Any rule failing fails the build and names the rule. Both allowances are measured at accept, on the agent being accepted: the pass tolerance is the spread of the three counts (highest minus lowest) with a floor of 1, the cost margin the spread of the three costs with a floor of 5% of their mean (`eval/baseline.ts` gives the reasoning). Rule 2 has no allowance, and a question that usually passes can enter the solid set by luck, so unchanged code turns the gate red about one run in nine, and about one in thirty again on a re-run, which meets the same baseline (`npm run simulate-gate` simulates both from the committed baseline); a red run's first move is one re-run of the job, and red twice is investigated. Everything else is measured and reported, not gated: recall and precision, empty answers, tool calls, Cypher errors, cut results, duration, and how each moved against the baseline. A reported metric becomes a gate once it is steady across runs and has an agreed budget.
- What the rules let through: a question falling from always to two in three holds rules 1 and 2, which is why the report prints every question's passes out of three next to the baseline's. A gate never says a change helped; its gains are in its experiment file.
- A question whose run threw or timed out, in any trial, is an error, not a failure: it says nothing about the agent, and a run with errors is incomplete. The build fails on it, with that reason. The graph is checked before the first question for the same reason: the query tool returns a database outage to the model as text, which would otherwise read as thirty wrong answers.
- The baseline is the benchmark declared working, and it moves only on purpose. A change whose three trials stay within the allowances ships on the baseline it was judged against: the allowances then keep measuring the drift since the benchmark was declared, instead of being reset by every change. The baseline is retaken in two cases: a gain worth protecting (questions newly solid, a lower cost), so the floor rises with the agent; and a red run the team decides to ship anyway, the accept commit stating the trade it signs (the score or cost given up, and why). A baseline that followed every change would ratchet like one that followed every green run, one allowance at a time, with a person typing the command; and a baseline that followed every green run is refused for the same reason. The order: commit the change, run `npm run eval -- --accept` on that commit (it refuses a dirty tree), and commit the baseline file apart from any change to the agent, its message giving the three counts, the three costs, both allowances, the accepted run's eval id and one line for each question that left the solid set. The run records stay local; CI's run of the accepting commit is the public check. The eval's history is the git history of `eval/baselines/`.

The approach follows Anthropic's [Building effective agents](https://www.anthropic.com/research/building-effective-agents) (the simplest thing that works, one measured addition at a time) and [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (the tool's interface is a design surface of its own).

## Tools

- A tool is one function with a zod input schema and a description written for someone who has never seen the system: what it does, what comes back and how to read it, what a failure looks like. The description is all the model knows about the tool.
- Output is compact text, and the fact the model must not miss comes first. For the query tool that is the row count, said explicitly for an empty result and for a cut one.
- A failure is returned as text (`Cypher error: …`), never thrown: the model is the party that can fix the query.
- Safety is enforced where the model cannot reach it. The query tool runs inside a database read transaction (see `docs/facts.md`), not behind a keyword filter.
- Tool names must not reuse a deepagents built-in name (`docs/facts.md`).

## Code

- Run `npm run typecheck` before proposing a commit.
- A file opens with a comment saying what the module is for and why it is shaped the way it is. Every exported function and type carries a one-line JSDoc saying what it is for. Comments explain intent; none narrate the code.
- The developer commands (`check`, `index`, `ask`, `eval`, `simulate-gate`) share one convention, in `src/cli.ts`: each answers `--help` with what it does, its options and their defaults, and an example; a usage error is one line that names the fix, printed before any token is spent or any data is written; a failure is one line, never a stack trace.
- `tsx` runs scripts and tests; the NestJS server runs from compiled output, because `tsx` drops the decorator metadata Nest's dependency injection needs.
- Dependencies are pinned exactly (`.npmrc` sets `save-exact`). Secrets live only in `.env`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, with `feat`, `fix`, `refactor`, `test`, `eval`, `docs`, `chore`, and the folder as the scope (`feat(agent): …`).

- The body says why the change was made and what it changed in our understanding; the diff already shows what.
- A commit that changes agent behaviour states the eval score before and after.
- One logical change per commit, made when the change works. Agents propose the commit (files and message) and the human makes the call.

## Keeping these docs true

A change that makes a line in this file wrong updates it in the same commit. `docs/facts.md` holds what is verified about the libraries, the graph, the questions and the answer key, each entry with evidence a reader can re-run and the date it was checked; re-verify an entry when its pinned version changes, and correct or remove one that no longer holds, the file's git history being the record. An experiment in `eval/experiments/` never changes its measured numbers; when later evidence overturns its reading of them, it gets one dated `Revised <date>:` line at the top.
