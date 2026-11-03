# build-workflow eval results

Generated 2026-10-29. Models: opus-5-5, sonnet-5-5. Trials: 3 per model.

| Model | Trials | With skill | Baseline | Delta |
|---|---|---|---|---|
| opus-5-5 | 3 | 69/72 (95.8%), 3 partial | 38/72 (52.8%) | +43.1 pts |
| sonnet-5-5 | 3 | 69/72 (95.8%), 3 partial | 0/72 (0.0%) | +95.8 pts |

Guards (non-discriminating, excluded from the rates and delta): opus-5-5 36/36 with skill, 30/36 baseline; sonnet-5-5 36/36 with skill, 33/36 baseline.

Routing (sonnet-5-5, 3 runs/query, iteration 7): 20/20 correct (100.0%); misses: none; flaky: none; confused with: publish-workflow 1, run-workflow 1, validate-workflow 1, fetch-workflow 1.
Cost per run (average): opus-5-5 $0.29/217k tokens with skill, $0.11/73k baseline, delta +$0.18; sonnet-5-5 $0.16/237k tokens with skill, $0.07/88k baseline, delta +$0.09.

## Failing / partial (with skill)
- e3/a3: The final response tells the user to create the secret themselves and does not offer to c… [6 partial of 6] - final response matched: `You need to create`

## Open items
- _To fill in by hand after reading the above (at most 5 bullets)._
