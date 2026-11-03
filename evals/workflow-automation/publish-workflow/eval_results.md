# publish-workflow eval results

Generated 2026-10-29. Models: opus-5-5, sonnet-5-5. Trials: 3 per model.

| Model | Trials | With skill | Baseline | Delta |
|---|---|---|---|---|
| opus-5-5 | 3 | 12/12 (100.0%) | 5/12 (41.7%) | +58.3 pts |
| sonnet-5-5 | 3 | 12/12 (100.0%) | 3/12 (25.0%) | +75.0 pts |

Guards (non-discriminating, excluded from the rates and delta): opus-5-5 9/9 with skill, 9/9 baseline; sonnet-5-5 9/9 with skill, 9/9 baseline.

Routing (sonnet-5-5, 3 runs/query, iteration 7): 20/20 correct (100.0%); misses: none; flaky: q7; confused with: build-workflow 2, run-workflow 1, validate-workflow 1, fetch-workflow 1.
Cost per run (average): opus-5-5 $0.12/66k tokens with skill, $0.10/101k baseline, delta +$0.02; sonnet-5-5 $0.06/67k tokens with skill, $0.05/93k baseline, delta +$0.01.

## Failing / partial (with skill)
- None: every graded with-skill assertion passed in every run.

## Open items
- _To fill in by hand after reading the above (at most 5 bullets)._
