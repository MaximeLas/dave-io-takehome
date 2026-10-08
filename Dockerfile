FROM neo4j:2026.04.0

COPY mock-infra.cypher /var/lib/neo4j/import/mock-infra.cypher
