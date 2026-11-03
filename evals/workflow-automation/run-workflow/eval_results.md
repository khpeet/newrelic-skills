# run-workflow eval results

Generated 2026-10-29. Models: opus-5-5, sonnet-5-5. Trials: 3 per model.

| Model | Trials | With skill | Baseline | Delta |
|---|---|---|---|---|
| opus-5-5 | 3 | 18/18 (100.0%) | 10/18 (55.6%) | +44.4 pts |
| sonnet-5-5 | 3 | 18/18 (100.0%) | 9/18 (50.0%) | +50.0 pts |

Guards (non-discriminating, excluded from the rates and delta): opus-5-5 9/9 with skill, 9/9 baseline; sonnet-5-5 9/9 with skill, 9/9 baseline.

Routing (sonnet-5-5, 3 runs/query, iteration 7): 20/20 correct (100.0%); misses: none; flaky: q5; confused with: validate-workflow 2, publish-workflow 1, fetch-workflow 1.
Cost per run (average): opus-5-5 $0.12/55k tokens with skill, $0.11/80k baseline, delta +$0.01; sonnet-5-5 $0.06/56k tokens with skill, $0.04/48k baseline, delta +$0.02.

## Failing / partial (with skill)
- None: every graded with-skill assertion passed in every run.

## Open items
- _To fill in by hand after reading the above (at most 5 bullets)._
