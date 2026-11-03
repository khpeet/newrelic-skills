---
title: Workflow Automation limits
source: https://docs.newrelic.com/docs/workflow-automation/limitations-and-faq/workflow-limits
---

The following limits apply to Workflow Automation:

| Limit                                                                     | Min        | Max                    |
| ------------------------------------------------------------------------- | ---------- | ---------------------- |
| Action output size                                                        |            | 100 KB                 |
| Action retry attempts                                                     |            | 3                      |
| Workflow definition total steps                                           | 1          | 100                    |
| Workflow definition size                                                  |            | 50 KB                  |
| Number of workflow definitions at account level (excluding version count) |            | 1,000                  |
| Number of workflow definitions at org level (excluding version count)     |            | 1,000                  |
| Number of versions per workflow definition at account level               |            | 1,000                  |
| Number of versions per workflow definition at org level                   |            | 1,000                  |
| Workflow duration                                                         |            | 7 days                 |
| Workflow run total steps                                                  |            | 5,000                  |
| Number of schedules                                                       |            | 30                     |
| Length of a workflow input value                                          |            | 1,000 characters       |
| State value max length                                                    |            | 1,000 characters       |
| State keys per state step                                                 |            | 10                     |
| Total state keys per workflow run                                         |            | 100                    |
| State key name max length                                                 |            | 255 characters         |
| Workflow concurrent runs (per account)                                    |            | 50                     |
| Signal input size                                                         |            | 10 KB                  |
| Number of conditions in switch step                                       |            | 10                     |
| Number of signals in wait step                                            |            | 10                     |
| Wait step max duration                                                    |            | 86,400 seconds (1 day) |
| Duration between schedules                                                | 10 minutes |                        |