# Experiments

One file per change that affects what the agent answers (prompt, tools, model, settings), named by date and subject, committed with the change itself. Each says which failure pattern the change targets, the hypothesis, the change, the measurement, what moved and what regressed, and the verdict. A variant measured and rejected on the way is reported in the entry it belongs to.

**How a change is measured.** Haiku 5.5 at effort high, three full runs of the thirty questions per variant (`npm run eval`, which runs three trials in one record, the measurement the gate makes), compared with the three runs before it. With nothing changed, a run moves by about ±2 passes, so a smaller gain is not a gain. The totals say whether a change helped; the per-question comparison says which questions moved and why.

| Date | Experiment | Passed, before → after (3 runs each) |
| --- | --- | --- |
| 2026-10-11 | [The `ids` rule](2026-10-11-ids-rule.md) | 13, 11, 10 → 20, 21, 21 |
| 2026-10-11 | [How a cloud engineer reads the questions](2026-10-11-conventions.md) | 20, 21, 21 → 24, 25, 25 |
| 2026-10-11 | [The shipped model: Haiku instead of Sonnet](2026-10-11-shipped-model.md) | Sonnet 22, 23, 23 → Haiku 24, 25, 25, 24 |
| 2026-10-12 | [How the agent reads a business area](2026-10-12-business-area.md) | 25, 25, 25, 24 → 27, 27, 24 |
