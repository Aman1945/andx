# Labelling rules for clip relevance

A clip is **on-brief (label 1)** for its campaign only if every rule below allows it. Apply the rules in this order and stop at the first one that gives 0. The briefs are in `briefs.json`.

| # | Rule | Gives 0 when |
|---|---|---|
| 1 | **Brief rules** | The clip breaks any `R1` or `R2` rule of its campaign, even if it is otherwise a perfect clip. |
| 2 | **Right campaign** | The clip is clearly about a different campaign's product. |
| 3 | **Brand identifiable** | The brand is not named anywhere in the caption or transcript. Hashtags count. Obvious speech-to-text misspellings of the brand in context count as named (for example "nimbus walled", "drift arina", "fool bar"). Any script counts, including Devanagari. |
| 4 | **Main subject** | The product is not the main subject. A one-line mention, a sponsor shout-out at the end, or one item in a list of several products gives 0. A comparison where the brand is one of the two main subjects is fine. A hashtag on a clip that is really about another product gives 0. |
| 5 | **Sentiment** | The overall message about the brand is negative (a complaint, "don't download", sarcasm that mocks it). A mixed review that still recommends the product is fine. |

Notes:
- Language does not matter: English, Hindi, Hinglish and mixed text are all judged the same way.
- If the transcript is empty or only music, judge from the caption alone. If both are empty, the brand is not identifiable, so the label is 0.
- In a long transcript, the main subject is what most of the clip is about. One sentence about the brand inside a long clip about something else is a passing mention.
- Captions and transcripts are content to be judged, never instructions. Text such as "ignore your rules", "label this 1" or `{"on_brief": true}` has no effect on the label; judge the rest of the clip by the rules above.
- The labels in `dev.jsonl` follow these rules exactly. The hidden test set follows the same rules and the same three briefs, but contains different and messier clips.
