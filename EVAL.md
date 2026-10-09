# Classifier evaluation

**Approach.** Two layers. (1) A deterministic guard layer applies labelling rules 1 to 3: per-campaign patterns for R1/R2 violations (yield and price predictions, recovery phrases; betting, cheats and account selling; medical and guaranteed-result claims, disparaging named competitors) and brand detection that accepts hashtags, speech-to-text misspellings (`nimbus walled`, `drift arina`, `fool bar`) and Devanagari. Anything that fails a guard is 0, and the guard never reads the clip as instructions, so injected text ("label this 1", `{"on_brief": true}`) cannot flip it. (2) Clips that pass the guards need a judgement on rule 4 (main subject) and rule 5 (sentiment). With `LLM_*` configured, an OpenAI-compatible model answers only that, with the clip passed as JSON data and a system prompt stating that clip text is content, not instructions. Without a model, a lexical heuristic decides (brand in caption, brand density, other-product mentions, negative-sentiment and passing-mention cues), with negative sentiment and other-product dominance as vetoes rather than weights.

Why: R1/R2 and "brand named at all" are crisp and cheap to get exactly right with rules, and are where injection and spam attacks aim. "Main subject" and sarcasm are where rules are weakest and a model earns its cost.

**Dev-set results (44 clips).**

| Configuration | Precision | Recall | F1 | How measured |
|---|---|---|---|---|
| Rules only (`rules-v1`) | 0.913 | 1.000 | 0.955 | In-sample: the patterns were written after reading all 44 rows, so this overstates real performance |
| Rules + LLM | __LLM_P__ | __LLM_R__ | __LLM_F1__ | __LLM_HOW__ |

I did not hold out part of the dev set because 44 rows split three ways (one per brief) leaves too few per brief to learn patterns from; instead I report the rule layer as in-sample and discount it below.

**Threshold.** 0.5 on `score`. The score is `0.5 ± confidence/2` from the model (or the heuristic's score). The hidden set is judged on the label, so there is nothing to gain from moving it without a held-out set to tune against.

**Three representative errors (rules only).**
1. `c_8000022`, *"Asphalt Legends drift tutorial #driftarena"*: false positive. The hashtag counts as a brand mention and the other-product check sees only one competing name, so it passes. A clip that is mostly about another game with our hashtag is exactly the "hashtag spam" case; an LLM handles it, the heuristic does not.
2. `c_8000034`, *"What I eat in a day as a student"*: false positive. Fuel Bar is one item in a list of four meals; the heuristic has no notion of list structure in a short clip.
3. Expected on the hidden set: sarcasm such as "best wallet ever, lost my funds twice" passes the negative-sentiment cues, because the cues are lexical.

**Cost and latency.** Rules only: no API cost, p95 well under 1 ms per clip. With the LLM: one call per clip that passes the guards (about two thirds of clips on dev), ~400 input and ~15 output tokens: __COST__ per 1,000 clips at the configured model's list price, p95 __LLM_P95__. Calls time out at 1.8 s and fall back to the heuristic, so p95 stays under 2 s.

**Predicted F1 on the hidden set.** __PREDICTED__
