// Offline measurement of retrieval over node descriptions, on the labelled search phrases
// in eval/search-dev-set.json, never on the eval's questions: tuning a cutoff on the set
// that scores the agent would make the score meaningless.
//
// Three rankings of the 79 distinct descriptions are compared, and the agent's own word
// lists as sets, when eval/search-word-lists.json is present:
// - vectors of the description alone (what the index stores);
// - vectors of the node's name plus its description (Neo4j's examples embed a title with the
//   text; our names add environment and serial numbers);
// - Neo4j's full-text index (Lucene, BM25), the standard keyword baseline, built for the
//   measurement and dropped after it.
// Then the cutoff: a fixed score threshold against "everything within a margin of the best
// match", chosen by F2 (recall counts twice: the agent filters what search returns, and
// cannot recover what it never saw). Scores are Neo4j's cosine scores, (1 + cos) / 2.
//
// Usage: npx tsx --env-file-if-exists=.env scripts/measure-search.ts
// It writes a full-text index into the database for its duration, so run it on a database
// no one else is reading.
import { existsSync, readFileSync } from "node:fs";

import { closeDriver, getDriver } from "../src/graph/driver.js";
import { embed } from "../src/search/embed.js";

interface Phrase {
  query: string;
  style: string;
  relevant: string[];
  partial: string[];
}
interface DevSet {
  phrases: Phrase[];
  descriptions: Record<string, string>;
}
/** A ranking: each description id with its score, best first. Unranked descriptions are absent. */
type Ranking = { id: string; score: number }[];

const devSet = JSON.parse(readFileSync("eval/search-dev-set.json", "utf8")) as DevSet;
const idOfText = new Map(Object.entries(devSet.descriptions).map(([id, text]) => [text, id]));

const driver = getDriver();
const { records } = await driver.executeQuery("MATCH (n:Entity) RETURN n.id AS id, n.name AS name, n.description AS text");
const nodes = records.map((r) => {
  const text = r.get("text") as string;
  const descriptionId = idOfText.get(text);
  if (!descriptionId) throw new Error(`Description not in the dev set: ${text}`);
  return { id: r.get("id") as string, name: r.get("name") as string, text, descriptionId };
});

const cosineScore = (a: number[], b: number[]) => (1 + a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0)) / 2;

/** Keeps each description's best score over its nodes, best first. */
function byDescription(scored: { descriptionId: string; score: number }[]): Ranking {
  const best = new Map<string, number>();
  for (const { descriptionId, score } of scored) best.set(descriptionId, Math.max(score, best.get(descriptionId) ?? -Infinity));
  return [...best].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

const descriptionIds = Object.keys(devSet.descriptions);
const descriptionVectors = await embed(descriptionIds.map((id) => devSet.descriptions[id] ?? ""));
const nodeVectors = await embed(nodes.map((n) => `${n.name}\n${n.text}`));
const phraseVectors = await embed(devSet.phrases.map((p) => p.query));

const FULLTEXT = "measure_descriptions_fulltext";
await driver.executeQuery(`CREATE FULLTEXT INDEX ${FULLTEXT} IF NOT EXISTS FOR (n:Entity) ON EACH [n.description]`);
await driver.executeQuery("CALL db.awaitIndex($name, 120)", { name: FULLTEXT });

const rankings: Record<string, Ranking[]> = { "vectors: description": [], "vectors: name + description": [], "full-text (BM25)": [] };
for (const [i, phrase] of devSet.phrases.entries()) {
  const q = phraseVectors[i] ?? [];
  rankings["vectors: description"]?.push(
    byDescription(descriptionIds.map((id, j) => ({ descriptionId: id, score: cosineScore(q, descriptionVectors[j] ?? []) }))),
  );
  rankings["vectors: name + description"]?.push(
    byDescription(nodes.map((n, j) => ({ descriptionId: n.descriptionId, score: cosineScore(q, nodeVectors[j] ?? []) }))),
  );
  const lucene = phrase.query.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, "\\$&");
  const { records: hits } = await driver.executeQuery(
    `CALL db.index.fulltext.queryNodes($name, $q) YIELD node, score RETURN node.description AS text, score`,
    { name: FULLTEXT, q: lucene },
  );
  rankings["full-text (BM25)"]?.push(
    byDescription(hits.map((h) => ({ descriptionId: idOfText.get(h.get("text") as string) ?? "", score: h.get("score") as number }))),
  );
}
await driver.executeQuery(`DROP INDEX ${FULLTEXT}`);
await closeDriver();

// Partial labels are defensible either way, so they are taken out of the ranking: they
// count neither as hits nor as misses.
const judged = (ranking: Ranking, p: Phrase) => ranking.filter((r) => !p.partial.includes(r.id));
const withRelevant = devSet.phrases.map((p, i) => ({ p, i })).filter(({ p }) => p.relevant.length > 0);
const withoutRelevant = devSet.phrases.map((p, i) => ({ p, i })).filter(({ p }) => p.relevant.length === 0);
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(xs.length, 1);
const pct = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(4);

function averagePrecision(ranking: Ranking, p: Phrase): number {
  let hits = 0;
  let sum = 0;
  judged(ranking, p).forEach((r, k) => {
    if (p.relevant.includes(r.id)) sum += ++hits / (k + 1);
  });
  return sum / p.relevant.length;
}
function recallAt(ranking: Ranking, p: Phrase, k: number): number {
  return judged(ranking, p).slice(0, k).filter((r) => p.relevant.includes(r.id)).length / p.relevant.length;
}

console.log("\nRanking quality, before any cutoff (phrases with at least one relevant description: %d)", withRelevant.length);
console.log("retriever                      MAP   R@5  R@10  R@20  missed entirely");
for (const [name, list] of Object.entries(rankings)) {
  const map = mean(withRelevant.map(({ p, i }) => averagePrecision(list[i] ?? [], p)));
  const r = (k: number) => mean(withRelevant.map(({ p, i }) => recallAt(list[i] ?? [], p, k)));
  const missed = mean(withRelevant.map(({ p, i }) => 1 - recallAt(list[i] ?? [], p, Infinity)));
  console.log(`${name.padEnd(30)} ${pct(map)}  ${pct(r(5))}  ${pct(r(10))}  ${pct(r(20))}  ${pct(missed)}`);
}
console.log("\nMAP by phrase style");
for (const style of [...new Set(withRelevant.map(({ p }) => p.style))]) {
  const these = withRelevant.filter(({ p }) => p.style === style);
  const cells = Object.entries(rankings).map(([name, list]) => `${name} ${pct(mean(these.map(({ p, i }) => averagePrecision(list[i] ?? [], p))))}`);
  console.log(`${style.padEnd(11)} (${these.length}) ${cells.join("   ")}`);
}

/** The descriptions a cutoff keeps from one ranking. */
type Cutoff = { label: string; keep: (ranking: Ranking) => Ranking };
const cutoffs: Cutoff[] = [];
for (let t = 0.6; t <= 0.9001; t += 0.01) {
  cutoffs.push({ label: `score >= ${t.toFixed(2)}`, keep: (r) => r.filter((x) => x.score >= t) });
}
for (let m = 0.01; m <= 0.1501; m += 0.01) {
  cutoffs.push({ label: `within ${m.toFixed(2)} of best`, keep: (r) => r.filter((x) => x.score >= (r[0]?.score ?? 0) - m) });
}
// Both at once: the margin follows each phrase's own score scale, the floor stops a phrase
// that matches nothing from returning a flat band of weak matches.
for (let t = 0.6; t <= 0.7501; t += 0.01) {
  for (let m = 0.05; m <= 0.1201; m += 0.01) {
    cutoffs.push({
      label: `>= ${t.toFixed(2)} and within ${m.toFixed(2)}`,
      keep: (r) => r.filter((x) => x.score >= t && x.score >= (r[0]?.score ?? 0) - m),
    });
  }
}
for (const k of [5, 10, 15, 20]) cutoffs.push({ label: `top ${k}`, keep: (r) => r.slice(0, k) });

function evaluate(list: Ranking[], cutoff: Cutoff) {
  const precision: number[] = [];
  const recall: number[] = [];
  for (const { p, i } of withRelevant) {
    const kept = judged(cutoff.keep(list[i] ?? []), p);
    const hits = kept.filter((r) => p.relevant.includes(r.id)).length;
    precision.push(kept.length === 0 ? 0 : hits / kept.length);
    recall.push(hits / p.relevant.length);
  }
  const P = mean(precision);
  const R = mean(recall);
  const f2 = P + R === 0 ? 0 : (5 * P * R) / (4 * P + R);
  const noise = mean(withoutRelevant.map(({ p, i }) => judged(cutoff.keep(list[i] ?? []), p).length));
  return { P, R, f2, noise };
}

for (const name of ["vectors: description", "vectors: name + description"]) {
  const list = rankings[name] ?? [];
  const scored = cutoffs.map((c) => ({ c, ...evaluate(list, c) })).sort((a, b) => b.f2 - a.f2);
  console.log(`\nCutoffs for ${name}, best F2 first (noise: descriptions returned for phrases with nothing relevant)`);
  console.log("cutoff                  precision  recall   F2  noise");
  for (const s of scored.slice(0, 6)) {
    console.log(`${s.c.label.padEnd(24)} ${pct(s.P)}     ${pct(s.R)}  ${s.f2.toFixed(2)}  ${s.noise.toFixed(1)}`);
  }
  const best = (kind: string) => scored.find((s) => s.c.label.startsWith(kind));
  for (const kind of ["score >=", "within", ">=", "top"]) {
    const s = best(kind);
    if (s) console.log(`best ${kind.padEnd(9)} ${s.c.label}: precision ${pct(s.P)}, recall ${pct(s.R)}, F2 ${s.f2.toFixed(2)}, noise ${s.noise.toFixed(1)}`);
  }
}

console.log("\nSets, compared with the vectors' top 10");
const asSet = (list: Ranking[], label: string, keep: Cutoff["keep"]) => {
  const s = evaluate(list, { label, keep });
  const missed = mean(withRelevant.map(({ p, i }) => 1 - recallAt(keep(list[i] ?? []), p, Infinity)));
  console.log(`${label.padEnd(34)} precision ${pct(s.P)}, recall ${pct(s.R)}, F2 ${s.f2.toFixed(2)}, noise ${s.noise.toFixed(1)}, missed entirely ${pct(missed)}`);
};
asSet(rankings["vectors: description"] ?? [], "vectors: description, top 10", (r) => r.slice(0, 10));
asSet(rankings["full-text (BM25)"] ?? [], "full-text, every match", (r) => r);

// The agent's own way of searching text: lower-case fragments ORed together in
// `toLower(n.description) CONTAINS ...`, written for each phrase by the agent's model
// without seeing the descriptions or the labels (eval/search-word-lists.json).
if (existsSync("eval/search-word-lists.json")) {
  const wordLists = JSON.parse(readFileSync("eval/search-word-lists.json", "utf8")) as Record<string, Record<string, string[]>>;
  for (const [writer, lists] of Object.entries(wordLists)) {
    const matched = devSet.phrases.map((p) =>
      descriptionIds
        .filter((id) => (lists[p.query] ?? []).some((w) => (devSet.descriptions[id] ?? "").toLowerCase().includes(w.toLowerCase())))
        .map((id) => ({ id, score: 1 })),
    );
    asSet(matched, `word lists, ${writer}`, (r) => r);
    // The agent with both tools: what the vectors add to what its own words already find.
    const vectorTop = rankings["vectors: description"] ?? [];
    const union = matched.map((m, i) => [...m, ...(vectorTop[i] ?? []).slice(0, 10).filter((v) => !m.some((x) => x.id === v.id))]);
    asSet(union, `  + vectors top 10 (union)`, (r) => r);
  }
}
