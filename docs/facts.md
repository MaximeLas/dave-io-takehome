# Verified facts

Facts about our libraries and tools that the code relies on, each checked against a primary source for the version we pin. Every entry carries its evidence as a command run from the repo root, so anyone can re-verify it. When a pinned version changes, re-run the evidence of every entry for that library and update or delete what no longer holds.

Format: a heading per fact, then the version, the evidence, and the date it was last checked.

## deepagents

### Structured output: wrap the schema in `toolStrategy()` or `providerStrategy()`

`createDeepAgent` accepts a `responseFormat`, and the result then carries a typed `structuredResponse`, so the answer shape is enforced by the library instead of requested in the prompt. A bare zod schema does not typecheck (TS2322), although the library's own docstring says it does; wrap it with `toolStrategy(schema)` or `providerStrategy(schema)` from `langchain`.

- Version: deepagents 1.14.2, langchain 1.5.16
- Evidence: `grep -n "SupportedResponseFormat =" node_modules/deepagents/dist/agent-*.d.ts` lists the accepted types; passing a bare `z.object(...)` as `responseFormat` fails `npm run typecheck`
- Checked: 2026-10-08

### Pass the model explicitly; the model id also changes the system prompt

Without a `model`, `createDeepAgent` uses `anthropic:claude-sonnet-4-6`. The model id also selects a model-specific harness profile that appends its own text to the system prompt, so changing the model changes the prompt too. Both are reasons to pin the model in our code and treat a model change like a library upgrade.

- Version: deepagents 1.14.2
- Evidence: `grep -n 'model = "anthropic:' node_modules/deepagents/dist/langsmith-*.js` (the default); `grep -n -o 'anthropic:claude-[a-z0-9-]*' node_modules/deepagents/dist/langsmith-*.js | sort -u` (the models with their own profile)
- Checked: 2026-10-08

### A Claude agent gets no `write_todos` planning tool by default

The to-do middleware is added only through the harness profile for OpenAI Codex models. Docs and the package README that list `write_todos` as always present are out of date for this version.

- Version: deepagents 1.14.2
- Evidence: `grep -n -B1 -A1 "todoListMiddleware()" node_modules/deepagents/dist/langsmith-*.js` (its one call site, inside `createExtraMiddleware`); `grep -n -A5 "function register()" node_modules/deepagents/dist/langsmith-*.js` (registered for `CODEX_MODEL_SPECS` only)
- Checked: 2026-10-08

### Custom tool names must not collide with built-in tool names

`createDeepAgent` throws `TOOL_NAME_COLLISION` if a custom tool reuses a built-in name: the filesystem tools (`ls`, `read_file`, `glob`, `grep`, …), the async task tools, or `task`.

- Version: deepagents 1.14.2
- Evidence: `grep -n -A3 "const collidingTools" node_modules/deepagents/dist/langsmith-*.js`
- Checked: 2026-10-08

### Known audit finding with no fix: `braces`, via `micromatch` and `fast-glob`

`npm audit` reports a high-severity denial of service (stack exhaustion on deeply nested patterns) in `braces`, which deepagents reaches through `micromatch` in its `glob` and `grep` tools and in filesystem permission rules. Our agent exposes neither tool (see "The built-in filesystem tools are replaced, not removed") and configures no permission rules, so no pattern the model writes reaches the vulnerable code. Were the tools re-enabled, the exposure would be one failed request, since the agent's filesystem is an in-memory backend scoped to a single run. No patched `braces` exists, and `npm audit fix --force` would downgrade deepagents to 0.0.2, so the finding is accepted.

- Version: deepagents 1.14.2
- Evidence: `npm audit --omit=dev`; `grep -n "micromatch.isMatch" node_modules/deepagents/dist/langsmith-*.js` (every call site sits in a `glob` or `grep` implementation, or in `globMatch`, the permission check)
- Checked: 2026-10-09

### The built-in filesystem tools are replaced, not removed

Passing `tools` to `createDeepAgent` adds to the built-in filesystem tools (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`); it never removes them. A middleware passed in `middleware` with the same `name` as a default one replaces it, so `createFilesystemMiddleware({ tools: ["read_file"] })` leaves a single filesystem tool; the library requires `read_file` in any explicit list. The `task` tool (the general-purpose subagent) stays. With that, the model sees exactly three tools: `run_cypher`, `read_file`, `task`.

The same replacement applies to the general-purpose subagent behind `task`: its middleware is merged with ours, so it also gets `read_file` alone.

- Version: deepagents 1.14.2
- Evidence: `grep -n "merged.set(middleware.name" node_modules/deepagents/dist/langsmith-*.js` (same-name replacement); `grep -n "must be included in every explicit array" node_modules/deepagents/dist/agent-*.d.ts`; `grep -n "generalPurposeSpec.middleware = mergeMiddlewareStack" node_modules/deepagents/dist/langsmith-*.js` (the subagent); `npm run ask -- "List the exact names of your tools, comma-separated, and call none."` answers `run_cypher, read_file, task` (one small model call)
- Checked: 2026-10-09

### A tool result over about 20,000 tokens is moved to the agent's filesystem

The filesystem middleware measures every tool result; one longer than 80,000 characters (its 20,000-token limit at four characters a token) is written to `/large_tool_results/<call id>.txt` in the agent's in-memory filesystem, and the model receives a short notice with the path and a preview instead, which it can page through with `read_file`. The filesystem tools' own results are exempt. The query tool's row cap keeps its results far below that size, so for `run_cypher` the cap, not the eviction, bounds what the model reads.

- Version: deepagents 1.14.2
- Evidence: `grep -n "toolTokenLimitBeforeEvict = \|toolTokenLimitBeforeEvict \* 4\|large_tool_results/" node_modules/deepagents/dist/langsmith-*.js`
- Checked: 2026-10-09

### Prompt caching is on by default for Anthropic models

`createDeepAgent` adds Anthropic's prompt-caching middleware whenever the model is an Anthropic one, for the main agent and its subagents, so each model call in a run reads the conversation so far from the cache and pays the full input price only on what is new. Nothing in our code turns it on; the run records show it as `cache_read` tokens on every model call after the first.

- Version: deepagents 1.14.2
- Evidence: `grep -n -A4 "if (anthropicModel) cacheMiddleware" node_modules/deepagents/dist/langsmith-*.js`; after any `npm run ask` with more than one model call, `usage.cacheReadTokens` in the saved `runs/*.json` is above zero
- Checked: 2026-10-09

### Reading the trace: one `AIMessage` per model call, `input_tokens` includes the cached tokens

`agent.invoke(...)` returns `messages`: one `AIMessage` per model call, whose `tool_calls` carry the calls it made and whose `usage_metadata` carries its tokens, and one `ToolMessage` per tool result, linked by `tool_call_id`. In `usage_metadata`, `input_tokens` is the sum of all input tokens, the cached ones included; `input_token_details.cache_read` and `cache_creation` split them out, so the full input price applies only to the difference.

- Version: deepagents 1.14.2, @langchain/core 1.2.17
- Evidence: `grep -n -B2 "input_tokens: number" node_modules/@langchain/core/dist/messages/metadata.d.ts` (the comment says "Sum of all input token types"); after `npm run ask -- dlq-for-prod-2`, each `usage_metadata` in the saved `runs/*.json` has `input_tokens` equal to `cache_creation` plus `cache_read` plus a handful
- Checked: 2026-10-08

## Anthropic SDK

### The SDK reads `ANTHROPIC_API_KEY`; this project's key is `APP_ANTHROPIC_API_KEY`

`ChatAnthropic` falls back to the `ANTHROPIC_API_KEY` environment variable, and a model given as a string (`"anthropic:…"`) is built with that fallback. This project names its key `APP_ANTHROPIC_API_KEY` to keep it apart from developer tooling that reads the default name, so the model is built explicitly: `new ChatAnthropic({ model, apiKey: process.env.APP_ANTHROPIC_API_KEY })`.

- Version: @langchain/anthropic 1.5.12
- Evidence: `grep -n '"ANTHROPIC_API_KEY"' node_modules/@langchain/anthropic/dist/chat_models.js`
- Checked: 2026-10-08

## TypeScript and NestJS

### `tsx` drops decorator metadata, so it runs scripts, not the NestJS server

`tsx` compiles with esbuild, which ignores `emitDecoratorMetadata`. NestJS's dependency injection reads that metadata, so a Nest app started with `tsx` gets undefined injections. Scripts run with `tsx`; the server runs from `tsc` output or the Nest CLI.

- Version: tsx 4.23.15, typescript 6.0.3
- Evidence: `echo 'const d = (t: any) => t; class A {} @d class B { constructor(a: A) {} }' | node_modules/.bin/esbuild --loader=ts --tsconfig-raw='{"compilerOptions":{"experimentalDecorators":true,"emitDecoratorMetadata":true}}' | grep -c __metadata` prints 0; the same source through `npx tsc --ignoreConfig --experimentalDecorators --emitDecoratorMetadata` emits `__metadata` calls
- Checked: 2026-10-08

### TypeScript 6, following NestJS's own pin

npm tags TypeScript 7 as `latest`, but NestJS's official starter pins `typescript ^6`. We follow the framework's pin.

- Version: typescript 6.0.3
- Evidence: `curl -s https://raw.githubusercontent.com/nestjs/typescript-starter/master/package.json | grep '"typescript"'`
- Checked: 2026-10-08

### TypeScript 6 needs `"types": ["node"]` in `tsconfig.json`

Without it, Node globals such as `process` fail to typecheck (TS2591), even with `@types/node` installed.

- Version: typescript 6.0.3
- Evidence: remove the `types` line from `tsconfig.json` and run `npm run typecheck`
- Checked: 2026-10-08

## Neo4j

### A read-mode transaction refuses writes on the server

`executeQuery(query, {}, { routing: neo4j.routing.READ })` runs the query in a read transaction, and the server rejects any write inside it (`Neo.ClientError.Statement.AccessMode`, "Writing in read access mode not allowed"). That makes the agent's query tool read-only without inspecting the query text. The fixture runs the Community edition, which has no read-only users or roles, so the transaction mode is the guard.

- Version: neo4j-driver 6.2.0, Neo4j 2026.04.0 Community
- Evidence: `docker compose exec -T neo4j cypher-shell -u neo4j -p neo4j --access-mode read "CREATE (x:Probe) RETURN x"` fails with "writing in read access mode"; `docker compose exec -T neo4j cypher-shell -u neo4j -p neo4j "CALL dbms.components() YIELD edition RETURN edition"` prints `community`
- Checked: 2026-10-08

### Unknown labels and relationship types are warnings, not errors

A query that names a label or relationship type absent from the database still runs and returns no rows; the result summary carries a notification with `severityLevel` `WARNING` (`Neo.ClientNotification.Statement.UnknownRelationshipTypeWarning` or `UnknownLabelWarning`) whose description names the missing one. The query tool forwards these warnings so that a misspelling is not read as an empty answer. Deprecation notices arrive the same way at a lower severity and are dropped.

- Version: neo4j-driver 6.2.0, Neo4j 2026.04.0
- Evidence: `curl -s -u neo4j:neo4j -H 'Content-Type: application/json' -d '{"statements":[{"statement":"MATCH ()-[:NOPE]->() RETURN count(*)"}]}' http://localhost:7474/db/neo4j/tx/commit | grep -o '"code":"[^"]*"'` lists the `UnknownRelationshipTypeWarning`
- Checked: 2026-10-08
