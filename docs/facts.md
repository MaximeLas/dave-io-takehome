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

`npm audit` reports a high-severity denial of service (stack exhaustion on deeply nested patterns) in `braces`, which deepagents uses for its always-on `glob` and `grep` tools. Those tools take patterns the model writes, and a chat user can influence the model, so a crafted message could make one request fail. The agent's filesystem is the default in-memory state backend, scoped to a single run, so nothing persists or leaks; the exposure is one failed request. No patched `braces` exists, and `npm audit fix --force` would downgrade deepagents to 0.0.2, so the finding is accepted.

- Version: deepagents 1.14.2
- Evidence: `npm audit --omit=dev`; `grep -n "micromatch" node_modules/deepagents/dist/langsmith-*.js`
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
