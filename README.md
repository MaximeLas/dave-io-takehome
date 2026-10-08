# Home Assignment: Infrastructure Knowledge Chat

Build a TypeScript application that lets a user chat with an AI agent about the infrastructure graph in this directory.

The provided Neo4j database is a disposable mock infrastructure knowledge graph for a fake ecommerce organization. It contains concrete AWS, GitHub, and Datadog resources across production-like and dev-like resource slices. Semantic context lives in each node's `description` field. Edges are represented by Neo4j relationship types such as `CALLS`, `GRANTS_ACCESS_TO`, `DEPLOYS_TO`, and `MONITORS`.

## Provided Fixture

Start Neo4j:

```bash
cd neo4j-infra-knowledge-graph
docker compose up --build
```

Neo4j Browser:

```text
URL: http://localhost:7474
Username: neo4j
Password: neo4j
```

Bolt connection:

```text
URL: bolt://localhost:7687
Username: neo4j
Password: neo4j
```

Stop and delete the ephemeral database:

```bash
docker compose down
```

## View The Graph

Open Neo4j Browser at http://localhost:7474 and log in with `neo4j` / `neo4j`.

Show all nodes and edges visually:

```cypher
MATCH (n)-[r]->(m)
RETURN n, r, m
LIMIT 500;
```

Show all nodes, including nodes with no visible relationship in the current result:

```cypher
MATCH (n)
RETURN n
LIMIT 500;
```

Show edge types:

```cypher
MATCH (n)-[r]->(m)
RETURN n.name AS source, type(r) AS relationship, m.name AS target
LIMIT 100;
```

## Assignment

Create a chat interface backed by a TypeScript NestJS backend. The backend should run an AI agent built with `deepagents`.

The agent should answer infrastructure questions:

- Read resource and relationship information from the provided Neo4j graph.
- Build or maintain a vector database from Neo4j resources.
- Retrieve relevant vector chunks for semantic context.
- Use graph traversal from Neo4j for structural context.
- Combine both sources when answering user questions.


## Desired State

The final application should provide:

- A chat UI where a user can ask questions about the mock infrastructure.
- A NestJS backend written in TypeScript.
- A DeepAgents-based agent that receives chat messages and returns grounded answers.
- A Graph RAG layer that uses both:
  - Neo4j graph relationships and relationship types.
  - A vector database populated from Neo4j node descriptions.
- Answers that refer to concrete resources, such as EC2 instances, S3 buckets, RDS instances, IAM policies, queues, GitHub workflows, and Datadog monitors.
- An evaluation harness that scores the agent's answers, runs in CI/CD, and fails the build on a score regression.

The graph intentionally does not model abstract services or environments as first-class nodes. If the user asks about production, dev, storefront, checkout, catalog, or fulfillment, the system should infer that context from resource names, descriptions, and graph neighborhoods.

## Evaluation

The 30 questions in [`eval/QUESTIONS.md`](eval/QUESTIONS.md) are the
specification of what the system has to be able to answer. Read them before you
design your retrieval layer.

Some are answerable from node descriptions alone. Others cannot be answered
without traversing relationships. A few are written so that the descriptions
point one way while the graph points another, and at least one has an empty
answer, where the correct response is that no such relationship exists.

## Evaluation Harness

Building the evaluation infrastructure for the agent is part of the assignment,
not an optional extra. Use any framework or approach you like.

It must:

- run the 30 questions against your agent and score the results,
- run in CI/CD, not only on your machine,
- compare each run against the scores of previous runs, and fail the build when
  the score regresses. How you record, store and compare past runs is your call.

`eval/expected.generated.json` gives a set of expected resource ids per question,
keyed by the same id as the questions and derived directly from the graph. Treat
it as a recommended reference for what a correct answer contains, not as the
whole rubric. You are expected to score on further metrics of your own choosing —
deciding what else is worth measuring about an answer, and how to measure it, is
part of what this assignment evaluates.

## Notes

- Keep the implementation in TypeScript.
- Use NestJS for the backend.
- Use `deepagents` for the agent runtime.
- Treat Neo4j as the source of truth for resource and relationship data.
- Treat node descriptions as the text source for vector indexing.
- Treat edge types as structural graph signals.
