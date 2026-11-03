# fetch-workflow eval results

Generated 2026-10-29. Models: opus-5-5, sonnet-5-5. Trials: 3 per model.

| Model | Trials | With skill | Baseline | Delta |
|---|---|---|---|---|
| opus-5-5 | 3 | 24/24 (100.0%) | 9/24 (37.5%) | +62.5 pts |
| sonnet-5-5 | 3 | 24/24 (100.0%) | 6/24 (25.0%) | +75.0 pts |

Guards (non-discriminating, excluded from the rates and delta): opus-5-5 6/6 with skill, 6/6 baseline; sonnet-5-5 6/6 with skill, 6/6 baseline.

Routing (sonnet-5-5, 3 runs/query, iteration 7): 20/20 correct (100.0%); misses: none; flaky: none; confused with: run-workflow 1, validate-workflow 1, publish-workflow 1, build-workflow 1.
Cost per run (average): opus-5-5 $0.10/62k tokens with skill, $0.09/61k baseline, delta +$0.01; sonnet-5-5 $0.06/63k tokens with skill, $0.04/58k baseline, delta +$0.01.

## Failing / partial (with skill)
- None: every graded with-skill assertion passed in every run.

## Open items
- _To fill in by hand after reading the above (at most 5 bullets)._
