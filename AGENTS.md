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
- `npm run ask -- <question-id | question text>` runs the agent on one question (an id from `eval/QUESTIONS.md`, or any text), prints every tool call and the answer with its cost, and saves the record under `runs/`.
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
- The model id lives in one place in `src/agent/`. Changing it, or upgrading a dependency, is its own commit with an eval run, so a score change can be attributed.
- The system prompt is one string whose hash goes into every run record, so a prompt change is attributable like a code change.

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
