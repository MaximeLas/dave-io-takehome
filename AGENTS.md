# AGENTS.md

Infrastructure knowledge chat: a NestJS backend runs a `deepagents` agent that answers questions about the mock infrastructure graph in Neo4j, combining graph traversal with vector search over node descriptions. An eval harness scores the agent on 30 fixed questions in CI and fails the build on a regression.

The assignment is `README.md`; the specification of what the agent must answer is `eval/QUESTIONS.md`.

## Where code goes

One npm package. Each piece of the system gets its own folder, created with its first file:

| Folder | Holds |
| --- | --- |
| `src/graph/` | Neo4j access: the driver and the queries the tools run |
| `src/search/` | the vector index over node descriptions, and the script that builds it |
| `src/agent/` | the agent: model, tools, system prompt |
| `src/server/` | the NestJS app that exposes the agent to the chat UI |
| `web/` | the chat UI |
| `eval/` | the questions, the expected answers, and the harness that scores the agent |
| `scripts/` | developer commands run with `tsx` |
| `runs/` | one JSON record per agent run (question, tool calls, tokens, cost, answer); gitignored |

Helpers that belong to no piece (`src/env.ts`, reading settings) stay at `src/`.

The eval harness and the server call the same agent entry point, `runAgent` in `src/agent/run.ts`, so what is scored is exactly what ships. It returns the run record that `runs/` stores.

**The assignment files are read-only:** `README.md`, `eval/QUESTIONS.md`, `eval/expected.generated.json`, `mock-infra.cypher`, `docker-compose.yml` and `Dockerfile` stay exactly as received. Our work goes in new files beside them.

## Running it

- Neo4j: `docker compose up -d --build` from the repo root (the README's `cd` step does not apply here). The seed loads 297 nodes and 579 relationships.
- `npm run check` before anything else: it checks the API key works, the agent library loads, and the graph is fully seeded, without spending model tokens.
- `npm run ask -- <question-id | question text>` runs the agent on one question (an id from `eval/QUESTIONS.md`, or any text), prints every tool call and the answer with its cost, and saves the record under `runs/`. `--model <id>` and `--effort <level>` override what ships; comparisons between models set the effort explicitly, because the API's default effort differs by model.
- `npm run eval` checks the graph is seeded, runs the thirty questions through the agent as it ships, scores each against the key, prints one row per question with its diagnostics, saves the eval record under `runs/eval/`, and compares the pass count with the committed baseline for that model and effort (`eval/baselines/`). Exit code: 0 when the baseline holds, 1 on a regression, 2 when the run cannot vouch for the agent (a question threw or timed out, or the configuration has no baseline yet), 3 on a usage error; only 0 ships. `--model` and `--effort` compare another configuration against its own baseline; `--only <ids>` runs a subset, reported and not compared; `--accept --tolerance <n>` declares the run the new baseline (the tolerance carries over when omitted on a later accept).
- `npm test` runs the grader's tests without a model or a database: the key scored against itself passes every question, an empty answer fails every question, and the gate's three verdicts. Run it before trusting any score.
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
- The system prompt is one string whose hash goes into every run record, so a prompt change is attributable like a code change. The record also carries the git commit the code ran from (`-dirty` when uncommitted), since the model reads the tools' text too.
- The answer is structured (`answer` prose for the user, `ids` for the eval), delivered by the model through a `final_answer` tool. One shape serves the chat and the eval, so what is scored is what the user reads; an eval-only answer format would score something that never ships.

## Scoring

- A question passes when the ids the answer asserts equal the expected ids exactly; the ids the question itself names count neither way, because the key is inconsistent about them. An empty answer (no `final_answer` call) never passes, even when the expected set is empty: no answer is not an answer of "none".
- The gate is the pass count against the baseline, minus a tolerance agreed from the measured run-to-run spread (the model samples, so the count moves with nothing changed). The spread is measured by running the full eval three times on the same commit; the tolerance is at least the highest count minus the lowest, and the three counts go in the commit message that accepts the baseline. Everything else is measured and reported, not gated: recall and precision per question, empty answers, tool calls, Cypher errors, cut results, cost, duration, and how each moved against the baseline. A reported metric becomes a gate once it is steady across runs and has an agreed budget.
- A question whose run threw or timed out is an error, not a failure: it says nothing about the agent, and a run with errors is incomplete. The build fails on it, with that reason. The graph is checked before the first question for the same reason: the query tool returns a database outage to the model as text, which would otherwise read as thirty wrong answers.
- The baseline moves only on purpose, and in this order: commit the change, run `--accept` on that commit (it refuses a dirty tree), commit the baseline file on its own with the scores in the message. The eval's history is the git history of `eval/baselines/`.

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
- `tsx` runs scripts only; the NestJS server runs from compiled output, because `tsx` drops the decorator metadata Nest's dependency injection needs.
- Dependencies are pinned exactly (`.npmrc` sets `save-exact`). Secrets live only in `.env`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, with `feat`, `fix`, `refactor`, `test`, `eval`, `docs`, `chore`, and the folder as the scope (`feat(agent): …`).

- The body says why the change was made and what it changed in our understanding; the diff already shows what.
- A commit that changes agent behaviour states the eval score before and after.
- One logical change per commit, made when the change works. Agents propose the commit (files and message) and the human makes the call.

## Keeping these docs true

A change that makes a line in this file wrong updates it in the same commit. `docs/facts.md` has its own rule: re-verify its entries when a pinned version changes.
