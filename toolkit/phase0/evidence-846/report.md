| Case | Full-line assertion | Actual real Orca speech |
| --- | --- | --- |
| before | FAIL | `日本🙂 ` |
| after | PASS | `日本🙂 word` |
| fault | FAIL | `日本🙂 ` |

The fault is CAUGHT: expected assertion failure, with publication and actual wrong-response logs.
