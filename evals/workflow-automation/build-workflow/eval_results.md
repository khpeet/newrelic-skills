# build-workflow eval results

Generated 2026-11-04. Models: opus-5-5, sonnet-5-5. Trials: 3 per model.

| Model | Trials | With skill | Baseline | Delta |
|---|---|---|---|---|
| opus-5-5 | 3 | 108/111 (97.3%), 3 partial | 63/111 (56.8%) | +40.5 pts |
| sonnet-5-5 | 3 | 108/111 (97.3%), 3 partial | 0/111 (0.0%) | +97.3 pts |

Guards (non-discriminating, excluded from the rates and delta): opus-5-5 42/42 with skill, 37/42 baseline; sonnet-5-5 42/42 with skill, 38/42 baseline.

Routing (sonnet-5-5, 3 runs/query, iteration 19): 20/20 correct (100.0%); misses: none; flaky: q11; confused with: publish-workflow 1, run-workflow 1, validate-workflow 1, fetch-workflow 1.
Cost per run (average): opus-5-5 $0.33/246k tokens with skill, $0.12/77k baseline, delta +$0.21; sonnet-5-5 $0.17/252k tokens with skill, $0.07/83k baseline, delta +$0.11.

## Failing / partial (with skill)
- e3/a3: The final response tells the user to create the secret themselves and does not offer to c… [6 partial of 6] - final response matched: You need to create

## Open items
- The partial result on e3/a3 is expected.
