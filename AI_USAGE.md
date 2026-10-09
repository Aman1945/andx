# AI usage

**Tool:** Claude Code (Anthropic, model Claude Opus 5.5), running in the terminal with access to this repository and a local Docker.

| Part | How AI was used | What was checked, changed or rejected |
|---|---|---|
| Reading the brief and kit | Summarised the spec, read the generator to learn the exact malformed-line kinds, and read the checker to see what is compared | Rules in section 4 were implemented from the spec text, not from the generator, so unseen seeds and hostile input are handled by rule rather than by pattern |
| Architecture | Proposed Redis Streams, one Postgres schema per service, the aggregator outbox, and earnings flushing inputs and outputs in one transaction | Rejected a single shared stream for views and clip_text (a slow classifier would block trimming); rejected computing V(clip, t) per request for spend (earnings must own it and cannot read agg) |
| Code | Wrote all five services, the schemas, scripts and tests | Fixed two issues found by running it: Node's type stripping does not support constructor parameter properties, and `"type": "module"` at the repo root broke the CommonJS generator, so ESM is scoped to our own folders |
| Tests | Wrote unit tests for validation, classification order, V(clip, t) with an out-of-order downward revision, and the remainder rule (including a randomized spend <= budget check) | Every number in the README comes from actual runs of the kit's checker, not from estimates |
| Failure testing | Wrote `scripts/chaos.sh` and ran SIGKILL tests for gateway, aggregator, earnings and api, a broker restart, a full re-send, and hostile lines | Results in the README are what those runs printed |
| Classifier | Wrote the rule layer, the LLM prompt and the evaluation script | The dev-set score is in-sample for the rule layer (rules were written after reading the dev set); EVAL.md says so and discounts the hidden-set estimate |
| Docs | Drafted README, DESIGN.md and EVAL.md | |

_Candidate's note: [Aman: describe here, in your own words, what you reviewed, questioned or changed, so this file matches what you actually did.]_
