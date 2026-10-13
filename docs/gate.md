# The gate: what it guarantees and what it does not

*The gate's three rules, where its allowances come from, how often it turns red on unchanged code, and the second accept round; the write-up's summary is in [`SOLUTION.md` § The gate in CI](../SOLUTION.md#the-gate-in-ci).*

The gate reads three trials (every question three times) against a baseline of three trials, and holds three rules, each a check for a drop (`eval/baseline.ts`, [`AGENTS.md` § Scoring](../AGENTS.md#scoring)):

1. **The average:** the mean pass count may not fall by more than the pass tolerance.
2. **The solid set:** a question that passed all six draws of the accept must pass at least two of three. The accept draws them in two rounds: the three trials, then up to three more runs of each question that passed them all, stopped at its first failure. The other questions are reported, never gated.
3. **Cost:** the mean cost per trial may not rise by more than the cost margin.

The current baseline is [`eval/baselines/claude-haiku-5-5.high.json`](../eval/baselines/claude-haiku-5-5.high.json), taken on 13 Oct on the shipped agent (prompt `1d555744`, with meaning search) with the two-round accept (commit `8bf30c0`):

- **Passes:** 24, 26, 26, with a tolerance of 2, so rule 1 fails at 69 passes or fewer over three trials (a mean of 23).
- **Cost:** 8.6 cents a trial with a margin of 1.06 cents, so rule 3 fails above 9.7 cents.
- **Solid set:** 24 questions. All 24 that passed the three trials also passed the second round's three runs (72 runs, 18.2 cents). The one question that left against the previous baseline, "Which instances can connect to rds-commerce-prod-4?", fell to 2 of 3 in the trials ([the experiment](../eval/experiments/2026-10-13-solid-six.md)).

In questions, against that baseline:

- **Caught:** a fall of more than two questions on the mean.
- **Caught:** any solid question falling to one of three.
- **Let through:** a solid question falling to two of three passes both rules, though the report prints it beside the baseline.

**Where the allowances come from.** The gate has to know how much the score moves when nothing changes, so that it does not fail a change for noise. It measures that from the three accept trials:

- **Each allowance is the spread of the three accept trials,** highest minus lowest. On the current baseline the three pass counts were 24, 26, 26, so the tolerance is 2; on the previous one (12 Oct, 25, 26, 26) it was 1.
- **Each has a floor,** one pass for the tolerance and 5% of the mean cost for the margin, because three trials can agree by luck and an allowance of zero would fail the next run on any wobble.
- **Three draws underestimate the noise.** Across the ten runs of the agent before meaning search on this prompt (the business-area experiment and the two baseline commits, `5a34d8e` and `268529c`), the pass count ranged from 24 to 27, a spread of 3; the three accept trials of 12 Oct happened to fall within 1, and those of 13 Oct within 2. The tolerance is therefore tighter than the real wobble, which is why unchanged code can go red and the policy below says re-run once.

A tolerance from one accept is a simplicity trade. Rejected: a hand-set tolerance, which turns each accept into an argument instead of a measurement; and more accept trials, which the second accept round below replaced.

**Unlucky draws.** Rule 2 has no allowance, so a question that usually passes and enters the solid set by luck turns the gate red on code that did not change. It happened twice on 13 Oct, on a pull request that changed only documentation: "Which instances would a deploy to the auto scaling group hit?" passed 1 of 3 in [CI run 38314893054](https://github.com/MaximeLas/dave-io-takehome/actions/runs/38314893054), then "Do any GitHub workflows deploy directly to a database?" passed 1 of 3 in [run 38319345402](https://github.com/MaximeLas/dave-io-takehome/actions/runs/38319345402), two of its trials listing the eight deploy workflows they had checked as the answer to a question whose answer is none; each re-run went green. The solid set was then earned over three draws; it is now earned over six, which cuts the chance that a question at 75% enters by luck from 42% to 18%. Simulated on the current baseline (`npm run simulate-gate`, `scripts/simulate-gate.ts`: 100,000 pairs of an accept and a later three-trial run of the same agent, seed 1, each question passing at its rate in the baseline file; [F27](facts.md#f27-on-unchanged-code-the-gate-is-red-about-one-run-in-nine-and-red-twice-about-one-in-twenty-seven)), on the same input:

| Entry to the solid set | Rule 2 red | Any rule red | Red again on one re-run |
| --- | --- | --- | --- |
| Three draws (`--rounds 1`) | 14.8% | 19.9%, one run in 5 | 7.5%, one in 13 |
| Six draws (the gate) | 4.5% | 11.1%, one run in 9 | 3.7%, one in 27 |

What the table does and does not say:

- **Rule 2's share falls to under a third.** What remains comes from the two questions at 2 of 3 in the baseline passing all six draws by luck.
- **The total falls less,** because rule 3 is now the largest single source (6.1%): the baseline's three costs include one trial at 9.3 cents and two at 8.3, a deviation the 5% floor on the margin barely covers. The cost rule over the solid questions only, in [the next steps](../SOLUTION.md#what-comes-next), would narrow it.
- **It is a floor.** The model takes a question at 6 of 6 as never failing, and both questions that broke rule 2 in CI are at 6 of 6 in this baseline. Pooled over the thirteen local eval records of the shipped prompt (not committed; [the experiment](../eval/experiments/2026-10-13-solid-six.md)), the gate is red 13.9% of the time with six draws against 18.6% with three.
- **Six draws do not end lucky entries:** a question at 85% still enters about four times in ten (0.85⁶ ≈ 0.38). The direct fix for the padding behind the second red is a change to the agent, for the improvement loop, not to the gate.

A red run is red again on one re-run more often than the square of the red rate would say (3.7% against 1.2%), because the re-run is judged against the same baseline and a wobbly question that entered the solid set by luck is still in it. An earlier estimate, from pass rates pooled over ten local runs, gave about one in a hundred after a re-run because it treated the re-run as independent of the accept. Policy: re-run once, investigate red twice. The re-run has a price: a real drop also gets two attempts, so a solid question that fell to passing half the time clears rule 2 on one attempt about half the time and on one of two about three times in four. The re-run buys fewer false reds at the cost of slower detection of a wobble; a collapse is caught either way.

How close the rules sit, as observed:

- **Rule 2, in CI:** three such reds occurred, all on the earlier three-draw entry. The first was on the first CI run of meaning search: "Do any GitHub workflows deploy directly to a database?" passed 1 of 3, a question that had passed 10 of 11 runs before and called no search ([meaning search](../eval/experiments/2026-10-12-meaning-search.md)). The other two are the documentation-only reds above.
- **Rule 1, in a local run** (not in CI, so not in the public record): a three-trial run of the same agent on 12 Oct scored 24, 25, 25, exactly the floor of 74 passes the 12 Oct baseline set. One fewer pass in any trial would have failed it.

The gate failing a real change is shown by closed pull request #2, a deliberate regression (the ids emptied) that went red with 2 passes on the earlier one-run gate. The three rules are covered by `eval/baseline.test.ts`.

**Gate and accept are two acts.**

- **The gate** checks every change against the baseline, the benchmark declared working.
- **`--accept`** re-declares the baseline, in its own commit, after a person has read the run: for a gain worth protecting, or for a red run shipped on purpose, the commit signing the trade.

Never after a neutral change: retaken after every change, a solid question that slips to two of three loses its protection, and the next change can lose it entirely within rule 1's tolerance, green both times. The rule was tightened to this once the three-trial gate made the ratchet visible. Meaning search shipped under it, with no accept (commit `0f202de`). The one retake since (commit `8bf30c0`) came from a change to the gate: the solid set's new entry rule, which the old baseline's format could not express.

**Sources.** The gate draws on Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) and Evan Miller's [Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640) for the pattern: several trials per question, the spread reported. It compares unpaired means, which is simpler and weaker than Miller's paired per-question differences.

**In CI,** the 90 agent runs take about 100 seconds and 27 cents ([run 38269765485](https://github.com/MaximeLas/dave-io-takehome/actions/runs/38269765485), on `0f202de`: 26, 26, 26). A red run names the rule, and the `runs-attempt-<n>` artifact holds every trace. The eval is a required check on `main`, so a red pull request cannot be merged.

**Every record carries two identities,** next to each other:

- **A fingerprint** of everything the model reads (the prompt, each tool's name, description and schema, the model id and its settings), which answers whether the model saw the same thing.
- **The git commit,** which answers whether the code changed.

The pair identifies a run.

## The second accept round

A question earns it by passing six accept draws instead of three, the three trials and then up to three more runs alone. For a question that passes 75% of the time, with independent trials, the chance of entering by luck falls from 42% to 18% (0.75³ against 0.75⁶); five trials at one accept, the option decision 8 deferred, would give 24%. The second round runs only the questions that passed the first, each stopped at its first failure, so a stable question costs at most three more runs and an unstable one stops early: at most 75 runs, about 22 cents, for 25 entrants at 0.3 cents a run. The mean and the cost still come from the three full trials. The 13 Oct accept ran it: 24 entrants, all passing six of six, 72 runs at 18.2 cents; on that baseline the simulated share of runs red under rule 2 fell from 14.8% to 4.5% ([the experiment](../eval/experiments/2026-10-13-solid-six.md)). Six draws do not end lucky entries (a question at 85% still enters about four times in ten, 0.85⁶ ≈ 0.38), so the paired comparison above remains the larger step, and the padding behind the two reds that prompted this change is the agent's to fix.
