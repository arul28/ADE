# Model sheet: first pass and owner decisions

Date: 2026-10-20 · branch `ade/free-jev-provider-integration` · registry snapshot
generated 2026-10-20T21:23:58Z (schemaVersion 1, 706 models, 42 agent rows, 218
media rows) · runnable models from this Mac Studio's `ade chat models` for
claude, codex, opencode and cursor (131 harness × model entries). Benchmark
data: Artificial Analysis (artificialanalysis.ai).

The sheet is the knowledge layer for a later single model picker. It says,
for every model this user can run, what kind of task it is good for. It keeps
two forms of the same knowledge: **numbers for code** (a 0-1 score per task
kind, speed and cost tiers) and **words for people and for Jev** (a summary,
strengths, weaknesses, best-for and avoid-for kinds). Jev, the free OpenCode
Zen classifier (`jev-1.13-free`), only has to say what kind of task a prompt
is; the experiment below checks how well it can also match a task to the words.
The composer keeps its separate `media` hint; the sheet scores vision but has
no audio task kind.

## How it is built

`apps/desktop/src/main/services/router/modelSheet.ts`, pure:
`buildModelSheet(snapshot, buildUserModelCatalog(models, snapshot))`.

1. **Families.** Each runnable model is grouped under the registry family the
   router maps it to (`modelCatalog.ts` / `routeCatalog.ts`). A model
   the router cannot map is looked up in the curated
   `modelSheetMatches.json`; only `same` and `same-model-faster-serving` lend
   a family's scores. A `nearest-sibling` or `none` match gets its own row with
   no scores and the match's reason as a note.
2. **Task-kind scores.** `scoreTaskKinds` min-max normalizes each benchmark
   over the variants Artificial Analysis lists today (not deprecated, not
   `carried`), flipping the lower-is-better ones, and takes the weighted mean
   from `TASK_KIND_WEIGHTS`. A model is scored on the benchmarks it has, as long
   as they carry at least `MIN_WEIGHT_COVERAGE` = 60% of the kind's weight;
   below that, or without a required benchmark, the kind is empty (shown `—`).
3. **Efforts.** Each model lists its effort levels with the variant AA
   measured at exactly that level (none is filled in from a neighbor), and the
   best measured effort per kind; two within `EFFORT_TIE` = 0.02 go to the
   cheaper one. The family headline uses `high` where measured, else AA's own
   default variant, so families compare at one effort.
4. **Tiers.** Speed from seconds per Intelligence Index task (fast ≤ 150 s,
   medium ≤ 500 s, else slow; fallback: end-to-end seconds for a 500-token
   answer, 12 / 40 s). Cost from dollars per index task (cheap ≤ $0.25, mid ≤
   $1.50, else premium; fallback: list price blended 3:1, $1 / $5 per M).
   Roughly the 25th and 75th percentiles of current models.
5. **Words.** Curated notes from `modelSheetNotes.json` (71 families: every
   runnable one plus the top 40 current by Intelligence Index), each with the
   `basis` benchmarks behind its claims. A family without notes gets words
   generated from its scores (top fifth = strength, bottom two fifths =
   weakness). Premium or slow models cannot list quick questions or small edits
   as best-for; those kinds are added to avoid-for. Scores refresh with every
   snapshot; the curated words do not.
6. **Order.** Families sort by the Intelligence Index of their headline
   variant; families without registry data come last, by name.

Surfaces: action `usage.getModelSheet` (`{ provider? }`, read-only, scoped like
`usage.getModelCatalog`) and `ade models sheet [--provider <p>] [--text]`.

## Weights per task kind

Rendered from `TASK_KIND_WEIGHTS`; each column sums to 1. `(req)`: without
this benchmark the kind has no score.

| Benchmark | ask | rsrch | review | edit | feat | debug | refac | write | vision |
|---|---|---|---|---|---|---|---|---|---|
| AA Intelligence Index | 0.3 | 0.15 | 0.25 | 0.15 | 0.15 | 0.1 | 0.05 | 0.15 | 0.2 |
| Terminal-Bench 4.0 |  |  | 0.15 | 0.25 | 0.3 | 0.35 | 0.25 |  |  |
| Terminal-Bench Hard |  |  |  |  |  | 0.05 |  |  |  |
| SciCode |  |  | 0.15 | 0.3 | 0.15 | 0.15 | 0.15 |  |  |
| IFBench (instruction following) |  |  |  | 0.15 |  |  | 0.1 | 0.15 |  |
| GPQA Diamond | 0.2 | 0.1 |  |  |  |  |  |  |  |
| Humanity's Last Exam |  | 0.3 |  |  |  |  |  |  |  |
| AA-LCR (long-context reasoning) |  | 0.25 | 0.2 |  |  |  | 0.2 |  |  |
| CritPt (physics research) |  | 0.1 |  |  |  |  |  |  |  |
| τ²-Bench Telecom (tool use) |  |  |  | 0.075 |  |  |  |  |  |
| τ-Bench Banking (tool use) |  |  |  | 0.075 |  |  |  |  |  |
| Terminal-Bench 2.1 |  |  |  |  | 0.05 | 0.05 |  |  |  |
| ITBench SRE (incident debugging) |  |  |  |  |  | 0.1 |  |  |  |
| FrontierCode |  |  |  |  | 0.1 |  |  |  |  |
| MMMU-Pro (image understanding) |  |  |  |  |  |  |  |  | 0.8 (req) |
| GDPval-AA (knowledge work) |  |  |  |  |  |  |  | 0.3 |  |
| AA Briefcase rubric (document work) |  |  |  |  |  |  |  | 0.15 |  |
| AA-Omniscience accuracy | 0.3 | 0.1 |  |  |  |  |  |  |  |
| AA-Omniscience hallucination rate | 0.2 |  | 0.1 |  |  |  |  | 0.15 |  |
| PersonalityBench slop |  |  |  |  |  |  |  | 0.1 |  |
| Coding Agent Index (mean over harnesses) |  |  | 0.15 |  | 0.25 | 0.2 | 0.25 |  |  |



Why each kind leans on what it does (from the comments in the code). AA no
longer runs some older evals (IFBench, GPQA, Terminal-Bench Hard, τ²-Bench)
on new models and runs others (FrontierCode, Briefcase, the Coding Agent
Index) only on featured ones, so every kind keeps at least 60% of its weight
on benchmarks every current model has and adds the rest where measured.

| Kind | Why these benchmarks |
|---|---|
| question | A quick answer must know things and not make them up: Omniscience accuracy and hallucination rate measure both; GPQA and the index add reasoning. |
| research | Digging through sources and long material to a sound conclusion: frontier reasoning (HLE, CritPt, GPQA) plus holding a long context (AA-LCR). |
| review | Reading a diff and its surroundings to find real problems: long-context reading, code understanding (SciCode, Terminal-Bench, agent index) and not inventing issues (hallucination rate). |
| small_edit | A small, well-specified change: competent code (SciCode), a short shell loop (Terminal-Bench), doing exactly what was asked (IFBench) and clean tool calls (τ-Bench). Nearly every coding model can. |
| feature | Building across files in an agent harness: Terminal-Bench and the Coding Agent Index measure exactly that; FrontierCode backs them up. |
| debugging | Reproducing and fixing a failure from a shell: Terminal-Bench is that loop; ITBench SRE is incident diagnosis; SciCode is careful code reasoning. |
| refactor | Many coordinated edits that keep behavior: agent work across a codebase, a long context, and following the constraints given (IFBench). |
| writing | Docs, PR descriptions, messages: knowledge-work output people rate well (GDPval, Briefcase), following the brief (IFBench), no made-up facts, no slop. |
| vision | Screenshots, diagrams, UI: MMMU-Pro is the image-understanding benchmark; without it, no vision score. |

## Curated matches (owner-approved)

The 17 runnable models the router cannot map onto the registry. All 17 are on
this Mac Studio's model lists, and every runnable model without a registry
family has a match. The owner approved all 17 on 2026-10-20. The JSON has no
status field, so the match data remains unchanged.

| Runnable model | Registry family | Relation | Confidence | Reason | Owner decision |
|---|---|---|---|---|---|
| `cursor/composer-2` | — | none | high | Cursor's own in-house coding model; Artificial Analysis does not measure Composer (no model page, not on its model list). | approved 2026-10-20 |
| `cursor/composer-2.5` | — | none | high | Cursor's own in-house coding model; Artificial Analysis does not measure Composer (no model page, not on its model list). | approved 2026-10-20 |
| `cursor/default` | — | none | high | Cursor's Auto mode is a router, not a model: Cursor picks a model per request, so no one benchmark applies. | approved 2026-10-20 |
| `cursor/muse-wonder-1.0` | `muse-wonder` | same | medium | Meta's Muse Wonder, released 2026-10-12; Artificial Analysis lists 'Muse Wonder (Max)' and a separate 'Muse Wonder Full'. Cursor's '1.0' with six effort levels reads as the standard model, not Full. **Availability doubt:** Cursor lists every model its models API returns for the API key (Cursor.models.list, else GET api.cursor.com/v1/models); a listing does not prove the plan can run it. Muse Wonder is eight days old and priced like a frontier model ($4/$20 per M); one short chat on it would confirm. | approved 2026-10-20 |
| `opencode/openai/gpt-5.3-codex-spark` | `gpt-5-3-codex` | nearest-sibling | medium | Codex Spark is a smaller, much faster model in the GPT-5.3 Codex line, not GPT-5.3 Codex itself; Artificial Analysis has no Spark page. models.dev bills it at GPT-5.3 Codex's price ($1.75/$14), which says nothing about quality. | approved 2026-10-20 |
| `opencode/openai/gpt-6-astra-ultrafast` | `gpt-6-astra` | same-model-faster-serving | high | GPT-6 Astra on OpenAI's Ultrafast tier: the same weights served faster at a higher price. Quality scores apply; measured speed does not. | approved 2026-10-20 |
| `opencode/openai/gpt-6.1-sol-ultrafast` | `gpt-6-1-sol` | same-model-faster-serving | high | GPT-6.1 Sol on OpenAI's Ultrafast tier: the same weights served faster at a higher price. Quality scores apply; measured speed does not. | approved 2026-10-20 |
| `opencode/opencode-go/beam-free` | `reflection-beam` | same | medium | Reflection's Beam 1.0 (Artificial Analysis 'Beam 1.0', released 2026-10-16), offered free for a limited time. The free tier may run a different checkpoint; nothing published says so. | approved 2026-10-20 |
| `opencode/opencode/beam-free` | `reflection-beam` | same | medium | Reflection's Beam 1.0 (Artificial Analysis 'Beam 1.0', released 2026-10-16), offered free for a limited time. The free tier may run a different checkpoint; nothing published says so. | approved 2026-10-20 |
| `opencode/opencode-go/hy4-preview` | `hy3` | nearest-sibling | low | Tencent Hy4 preview has no Artificial Analysis page; Hy3 is the previous generation and says little about Hy4. | approved 2026-10-20 |
| `opencode/opencode-go/longcat-2.5-preview-free` | `longcat-2-0` | nearest-sibling | low | LongCat 2.5 preview has no Artificial Analysis page; LongCat 2.0 is the previous release. | approved 2026-10-20 |
| `opencode/opencode/longcat-2.5-preview-free` | `longcat-2-0` | nearest-sibling | low | LongCat 2.5 preview has no Artificial Analysis page; LongCat 2.0 is the previous release. | approved 2026-10-20 |
| `opencode/opencode-go/qwen3.8-flash` | `qwen3-8-flash-next` | same | medium | Artificial Analysis lists one Qwen3.8 Flash model, 'Qwen3.8-Flash-Next', at exactly the price models.dev gives qwen3.8-flash ($0.15 in, $0.47 out, $0.016 cache read). The names differ, so this is likely but not certain. | approved 2026-10-20 |
| `opencode/opencode/qwen3.8-flash` | `qwen3-8-flash-next` | same | medium | Artificial Analysis lists one Qwen3.8 Flash model, 'Qwen3.8-Flash-Next', at exactly the price models.dev gives qwen3.8-flash ($0.15 in, $0.47 out, $0.016 cache read). The names differ, so this is likely but not certain. | approved 2026-10-20 |
| `opencode/opencode/big-pickle` | — | none | high | A stealth model on OpenCode Zen: the lab behind it is not published, so no benchmark can be tied to it. | approved 2026-10-20 |
| `opencode/opencode/grok-build-0.1` | `grok-build-0-1-0616` | same | medium | Artificial Analysis measured 'Grok Build 0.1 0616' at the same price xAI lists for grok-build-0.1 ($1/$2). AA no longer lists it as current, so its numbers are from June and xAI may have updated the model since. | approved 2026-10-20 |
| `opencode/opencode/nemotron-3-ultra-free` | `nemotron-3-ultra-550b-a55b` | same | high | NVIDIA Nemotron 3 Ultra 550B A55B, the only Nemotron 3 Ultra; the free route is the same open-weights model. | approved 2026-10-20 |

## The owner's sheet (Mac Studio, 2026-10-20)

68 families (61 with registry data, 7 without), 131 runnable entries. Scores at
the family headline effort; `—` = not enough data. "runs via" is harness and
billing (`plan`, `metered`, `free`). Summaries are curated unless marked
*(generated)* (10 families).

| # | Family | ask | rsrch | review | edit | feat | debug | refac | write | vision | speed | cost | runs via | summary |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Claude Opus 5.5 | 0.79 | 0.93 | 0.84 | 0.90 | 0.90 | 0.90 | 0.91 | 0.75 | 0.96 | medium | premium | claude plan, cursor plan, opencode metered | The strongest all-round model you can run: top-tier at hard coding, debugging, refactors and research, at a premium price. |
| 2 | Gemini 4 Argon | 0.83 | 0.88 | 0.90 | 0.91 | 0.88 | 0.90 | 0.90 | 0.81 | — | slow | premium | cursor plan, opencode metered, opencode plan | Google's frontier model: at or near the top for code review, debugging and refactors, with very few made-up facts; slow and premium per task. |
| 3 | Muse Wonder | 0.75 | 0.84 | 0.87 | 0.87 | 0.86 | 0.86 | 0.87 | 0.84 | — | medium | premium | cursor plan | Meta's new frontier model: near the top for review, edits, features, debugging and the best writing among runnable models; premium price. |
| 4 | Claude Fable 5.1 | 0.80 | 0.92 | 0.81 | 0.85 | 0.86 | 0.85 | 0.87 | 0.71 | — | medium | premium | claude plan, cursor plan, opencode metered | Anthropic's top-tier Fable model: superb at research and refactors, strong at coding, but the most expensive per task. |
| 5 | GPT-6 Astra | 0.84 | 0.89 | 0.83 | 0.83 | 0.86 | 0.85 | 0.86 | 0.73 | 0.96 | medium | premium | codex plan, opencode metered | OpenAI's frontier model: excellent at debugging, features and knowledge questions, priced at the top of the market. |
| 6 | GPT-6.1 Sol | 0.79 | 0.88 | 0.82 | 0.82 | 0.82 | 0.81 | 0.84 | 0.71 | 0.94 | medium | mid | codex plan, opencode metered | Near-frontier coding and research at a mid price: the value pick among OpenAI's large models, strongest in Codex. |
| 7 | Claude Fable 5 | — | 0.91 | 0.85 | 0.79 | 0.77 | 0.76 | 0.80 | — | — | slow | premium | cursor plan | The previous Fable: still strong at research and review, but superseded by Fable 5.1 and very expensive. |
| 8 | Claude Opus 5 | — | 0.88 | 0.82 | 0.78 | 0.77 | 0.76 | 0.80 | — | — | slow | premium | claude plan, opencode metered | The previous Opus: strong at research and review but replaced by Opus 5.5, which is better and cheaper per task. |
| 9 | Muse Spark 1.3 | 0.77 | 0.83 | 0.77 | 0.76 | 0.69 | 0.67 | 0.73 | 0.81 | — | medium | premium | cursor plan, opencode metered, opencode plan | Meta's mid-tier model: strong writing and questions, decent coding, fast output. |
| 10 | Claude Sonnet 5.5 | 0.68 | 0.79 | 0.73 | 0.75 | 0.72 | 0.72 | 0.75 | 0.67 | — | medium | mid | claude plan, cursor plan, opencode metered | Anthropic's balanced workhorse: good at coding, debugging and refactors at a mid price, with a big jump at higher effort. |
| 11 | Grok 4.7 | 0.73 | 0.74 | 0.74 | 0.67 | 0.60 | 0.57 | 0.67 | 0.81 | — | slow | premium | cursor plan, opencode metered, opencode plan | xAI's current model: excellent writing with almost no slop, middling coding, slow and premium per task. |
| 12 | MiMo-V2.6-Pro | 0.64 | 0.82 | 0.79 | 0.75 | 0.71 | 0.68 | 0.78 | 0.74 | — | slow | cheap | opencode plan | An open-weights model with near-frontier refactor and review scores at a very low price, but very slow per task. |
| 13 | Qwen3.8 Max (0902) | 0.71 | 0.75 | 0.77 | 0.73 | 0.72 | 0.70 | 0.75 | 0.74 | 0.90 | slow | premium | opencode plan | Qwen3.8 Max 0902 is balanced across coding and writing, with strong image understanding; it is extremely slow and premium per task. |
| 14 | DeepSeek V4.1 Flash 1017 | 0.61 | 0.77 | 0.72 | 0.70 | 0.68 | 0.64 | 0.74 | 0.69 | 0.88 | medium | mid | opencode free, opencode metered, opencode plan | DeepSeek V4.1 Flash 1017 improves on the September build at a mid price, with strong research and refactor scores but frequent made-up facts. |
| 15 | GLM-5.3 | 0.71 | 0.75 | 0.77 | 0.79 | 0.71 | 0.73 | 0.75 | 0.76 | — | slow | premium | cursor plan, opencode metered, opencode plan | Z AI's open-weights flagship: solid at every coding kind and writing, slow and fairly costly per task. |
| 16 | Grok 4.6 | — | 0.81 | 0.73 | 0.64 | 0.56 | 0.53 | 0.66 | — | — | medium | mid | cursor plan | A deprecated Grok: good research, middling coding; replaced by Grok 4.7. |
| 17 | Step 5 Preview | 0.65 | 0.79 | 0.74 | 0.72 | 0.64 | 0.67 | 0.71 | 0.69 | 0.83 | slow | mid | opencode plan | An open-weights preview with balanced scores: decent at everything, best at research and review, mid-priced. |
| 18 | Kimi K3 | 0.72 | 0.83 | 0.70 | 0.63 | 0.57 | 0.54 | 0.64 | 0.68 | 0.87 | slow | premium | cursor plan, opencode metered, opencode plan | An open-weights model with the best long-context reading of any runnable model; good at research, weak at shell-driven coding and slow. |
| 19 | MiniMax-M3.1-Flash | 0.60 | 0.80 | 0.64 | 0.63 | 0.58 | 0.55 | 0.67 | 0.59 | 0.85 | slow | cheap | opencode free | A brand-new, very cheap model that is good at research and long documents but often makes things up and is slow per task. |
| 20 | GPT-6 Sol | — | 0.80 | 0.73 | 0.64 | 0.59 | 0.56 | 0.69 | — | — | fast | mid | codex plan, opencode metered | The September GPT-6 Sol, replaced weeks later by GPT-6.1 Sol: fast, mid-priced, decent coding. |
| 21 | GPT-5.6 Sol | — | 0.82 | 0.72 | 0.66 | 0.55 | 0.52 | 0.68 | — | — | medium | mid | codex plan, cursor plan, opencode metered | The previous Sol: good at research, decent coding; replaced by GPT-6.1 Sol. |
| 22 | GLM-5.3-Flash | 0.67 | 0.71 | 0.73 | 0.68 | 0.65 | 0.67 | 0.70 | 0.73 | — | slow | mid | cursor plan, opencode free, opencode metered, opencode plan | A cheap open-weights GLM that keeps most of GLM-5.3's coding and writing at a seventh of the cost; slow per task. |
| 23 | Claude Opus 4.8 | — | 0.82 | 0.70 | 0.63 | 0.55 | 0.52 | 0.65 | — | — | slow | premium | opencode metered | Claude Opus 4.8: among the stronger current models for research; slow, premium. *(generated)* |
| 24 | Gemini 3.8 Flash | 0.74 | 0.80 | 0.62 | 0.64 | 0.51 | 0.54 | 0.56 | 0.56 | 0.92 | medium | mid | cursor plan, opencode metered | A fast-ish, mid-priced Google model that is strong at questions, research and images but weak at agentic coding. |
| 25 | Qwen3.8-Flash-Next | 0.61 | 0.68 | 0.67 | 0.63 | 0.58 | 0.56 | 0.65 | 0.72 | 0.85 | slow | mid | opencode metered, opencode plan | A cheap Qwen model that writes and reviews decently, handles images, and is very slow per task. |
| 26 | Muse Spark 1.2 | — | 0.80 | 0.65 | 0.54 | 0.43 | 0.39 | 0.56 | — | — | medium | mid | opencode plan | The previous Muse Spark: very fast output, good research; replaced by Muse Spark 1.3. |
| 27 | Gemini 3.7 Flash | — | 0.83 | 0.68 | 0.58 | 0.48 | 0.44 | 0.61 | — | — | medium | mid | cursor plan | A deprecated fast Gemini Flash: good research per dollar, weak at agentic coding. |
| 28 | Grok 4.5 | — | 0.78 | 0.65 | 0.54 | 0.45 | 0.41 | 0.57 | — | — | medium | mid | cursor plan | An older, deprecated Grok: good research, weak coding. |
| 29 | Mistral Large 4 Preview | 0.53 | 0.63 | 0.69 | 0.63 | 0.57 | 0.55 | 0.68 | 0.60 | 0.81 | slow | mid | opencode metered | Mistral's preview flagship: balanced mid-pack scores, decent refactors, slow per task. |
| 30 | MiMo-V2.6-Flash | 0.50 | 0.61 | 0.63 | 0.58 | 0.52 | 0.50 | 0.62 | 0.68 | 0.77 | slow | cheap | opencode free, opencode plan | A very cheap open-weights model with decent writing, slow per task. |
| 31 | Claude Haiku 5.5 | 0.57 | 0.67 | 0.57 | 0.56 | 0.41 | 0.40 | 0.49 | 0.63 | — | medium | cheap | claude plan, cursor plan, opencode metered, opencode plan | Anthropic's small model: cheap and fast, fine for quick questions and simple writing, weak at hard coding. |
| 32 | GPT-5.5 | — | 0.81 | 0.65 | 0.59 | 0.43 | 0.39 | 0.62 | — | — | medium | premium | cursor plan, opencode metered | An older OpenAI model, now deprecated: fine at research, weak at agentic coding, expensive. |
| 33 | DeepSeek V4 Pro 0813 | 0.60 | 0.74 | 0.54 | 0.55 | 0.45 | 0.43 | 0.52 | 0.51 | — | medium | mid | opencode metered, opencode plan | DeepSeek's larger model: good at research, middling coding, and makes up facts very often. |
| 34 | GPT-5.6 Terra | 0.58 | 0.72 | 0.52 | 0.53 | 0.38 | 0.38 | 0.53 | 0.54 | 0.82 | fast | mid | codex plan, cursor plan, opencode metered | A fast, cheap OpenAI model for questions and research; not for agentic coding. |
| 35 | GLM-5.2 | — | 0.75 | 0.57 | 0.52 | 0.33 | 0.29 | 0.54 | — | — | slow | mid | cursor plan, opencode plan | The previous GLM, deprecated: good instruction following, weak agentic coding. |
| 36 | GPT-6 Luna | 0.48 | 0.64 | 0.53 | 0.45 | 0.35 | 0.31 | 0.51 | 0.48 | 0.80 | fast | cheap | codex plan, opencode metered, opencode plan | OpenAI's tiny, fast, very cheap model: fine for quick questions and simple text, poor at debugging and agentic coding. |
| 37 | GPT-5.3 Codex | 0.61 | 0.75 | — | — | — | — | — | — | 0.81 | slow | mid | cursor plan | An older Codex coding model with few current benchmarks; Codex Spark is a smaller, faster sibling. |
| 38 | GPT-5.6 Luna | — | 0.70 | 0.58 | 0.45 | 0.34 | 0.30 | 0.51 | — | — | fast | cheap | codex plan, cursor plan, opencode metered, opencode plan | The previous Luna, deprecated: tiny, fast, cheap; replaced by GPT-6 Luna. |
| 39 | Claude Sonnet 5 | — | 0.67 | 0.58 | 0.48 | 0.37 | 0.33 | 0.52 | — | — | medium | premium | claude plan, cursor plan, opencode metered | The previous Sonnet, deprecated: replaced by Sonnet 5.5, which is much better at the same price. |
| 40 | Claude Opus 4.7 | — | 0.68 | — | — | — | — | — | — | — | — | premium | cursor plan | An old Opus, deprecated: expensive and outclassed by Opus 5.5. |
| 41 | Beam 1.0 | 0.50 | 0.61 | 0.46 | 0.42 | 0.23 | 0.21 | 0.35 | 0.46 | — | fast | mid | opencode free | Reflection's new open-weights model: very fast with a quick first token, but weak at coding. |
| 42 | Gemini 3.1 Pro Preview | 0.68 | 0.77 | 0.58 | 0.59 | 0.40 | 0.42 | 0.60 | 0.46 | 0.84 | fast | mid | cursor plan | An older Google Pro preview: good at questions and research, fast, but weak at agentic coding and writing. |
| 43 | MiniMax-M3 | 0.57 | 0.63 | 0.58 | 0.52 | 0.33 | 0.33 | 0.56 | 0.68 | 0.80 | medium | mid | opencode metered, opencode plan | An open-weights model with strong instruction following and very few made-up facts, weak at agentic coding. |
| 44 | Grok Build 0.1 0616 | — | 0.69 | — | — | — | — | — | — | — | — | mid | opencode metered | xAI's coding-agent model as measured in June; few benchmarks published. |
| 45 | Qwen3.6 Plus | — | 0.64 | — | — | — | — | — | — | — | — | mid | opencode metered | An old Qwen, deprecated: few current benchmarks. |
| 46 | Nemotron 3.5 Super VL | 0.45 | 0.53 | 0.51 | 0.38 | 0.28 | 0.24 | 0.43 | 0.43 | — | fast | cheap | opencode free | NVIDIA's very fast, cheap open-weights vision-language model: quick answers, weak at coding. |
| 47 | MiMo-V2.5-Pro | — | 0.69 | 0.53 | 0.50 | 0.29 | 0.25 | 0.54 | — | — | slow | cheap | opencode plan | An older MiMo, deprecated: cheap, good instruction following, weak agentic coding. |
| 48 | Kimi K2.7 Code | 0.52 | 0.64 | 0.48 | 0.47 | 0.32 | 0.32 | 0.50 | 0.42 | — | medium | mid | cursor plan, opencode metered, opencode plan | An older Kimi coding model: decent instruction following, weak at modern agentic coding. |
| 49 | Hy3 | 0.50 | 0.60 | 0.48 | 0.39 | 0.31 | 0.28 | 0.47 | 0.37 | — | medium | cheap | opencode plan | Tencent's open-weights model: very cheap, fine for questions, weak at coding. |
| 50 | MiMo-V2.5 | — | 0.60 | 0.48 | 0.43 | 0.26 | 0.22 | 0.47 | — | — | — | cheap | opencode plan | An old MiMo, deprecated: cheap, weak at coding. |
| 51 | Qwen3.7 Plus | 0.55 | 0.59 | 0.52 | 0.49 | 0.30 | 0.31 | 0.51 | 0.49 | 0.80 | slow | cheap | opencode plan | A cheap older Qwen: good instruction following and image input, weak at coding. |
| 52 | GPT-5.4 mini | — | 0.62 | 0.52 | 0.50 | 0.30 | 0.27 | 0.53 | — | — | medium | mid | cursor plan | An old small OpenAI model, deprecated: fast output, weak at coding. |
| 53 | Claude Opus 4.5 | — | 0.50 | — | — | — | — | — | — | — | — | premium | opencode metered | Claude Opus 4.5: below the top fifth of current models on every task kind; premium. *(generated)* |
| 54 | Nemotron 3 Ultra 550B A55B | 0.53 | 0.55 | 0.50 | 0.45 | 0.26 | 0.26 | 0.51 | 0.56 | — | fast | mid | opencode free | NVIDIA's large open-weights model: fast, follows instructions well, weak at agentic coding. |
| 55 | Gemini 3.5 Flash-Lite | 0.54 | 0.48 | 0.49 | 0.32 | 0.27 | 0.24 | 0.43 | 0.43 | 0.78 | fast | cheap | opencode metered | Google's smallest, fastest model: very cheap, good for quick questions and images, not for coding. |
| 56 | GPT-5.4 nano | — | 0.60 | 0.47 | 0.46 | 0.25 | 0.23 | 0.51 | — | — | medium | cheap | cursor plan | An old tiny OpenAI model, deprecated: cheap, weak at everything but simple text. |
| 57 | Claude 4.5 Sonnet | — | 0.38 | — | — | — | — | — | — | — | — | premium | opencode metered | Claude 4.5 Sonnet: below the top fifth of current models on every task kind; premium. *(generated)* |
| 58 | LongCat 2.0 | 0.42 | 0.52 | 0.37 | 0.27 | 0.22 | 0.20 | 0.36 | 0.27 | — | slow | cheap | opencode plan | An open-weights model with a long context but weak scores across the board. |
| 59 | Gemini 3 Flash Preview | — | 0.44 | — | — | — | — | — | — | — | — | mid | cursor plan | An old Gemini Flash preview, deprecated: few current benchmarks. |
| 60 | Claude 4.5 Haiku | — | 0.32 | — | — | — | — | — | — | — | — | mid | cursor plan, opencode metered | An old Haiku, deprecated: superseded by Claude Haiku 5.5. |
| 61 | Nemotron 3.5 Lightning | 0.39 | 0.34 | 0.36 | 0.21 | 0.16 | 0.15 | 0.32 | 0.25 | — | fast | cheap | opencode free | NVIDIA's tiny, very fast model: cheap quick answers only. |
| 62 | Auto | — | — | — | — | — | — | — | — | — | — | — | cursor plan | Auto: no public benchmark data, so the sheet cannot say what it is good for. *(generated)* |
| 63 | Big Pickle | — | — | — | — | — | — | — | — | — | — | — | opencode metered | Big Pickle: no public benchmark data, so the sheet cannot say what it is good for. *(generated)* |
| 64 | Composer 2 | — | — | — | — | — | — | — | — | — | — | — | cursor plan | Composer 2: no public benchmark data, so the sheet cannot say what it is good for. *(generated)* |
| 65 | Composer 2.5 | — | — | — | — | — | — | — | — | — | — | — | cursor plan | Composer 2.5: no public benchmark data, so the sheet cannot say what it is good for. *(generated)* |
| 66 | GPT-5.3 Codex Spark | — | — | — | — | — | — | — | — | — | — | — | opencode metered | GPT-5.3 Codex Spark: no public benchmark data, so the sheet cannot say what it is good for. *(generated)* |
| 67 | Hy4 preview | — | — | — | — | — | — | — | — | — | — | — | opencode plan | Hy4 preview: no public benchmark data, so the sheet cannot say what it is good for. *(generated)* |
| 68 | LongCat 2.5 Preview Free | — | — | — | — | — | — | — | — | — | — | — | opencode free | LongCat 2.5 Preview Free: no public benchmark data, so the sheet cannot say what it is good for. *(generated)* |

## Size and cost (first-pass baseline, before owner decisions)

These output sizes predate the removal of the audio kind and the note and
routing updates below. The refreshed table has nine scored kinds; output sizes
were not remeasured in this pass.

| Output | Raw | gzip |
|---|---|---|
| `ade models sheet` JSON, all providers | 186,816 B | 22,325 B |
| `ade models sheet --text`, all providers | 54,204 B | 10,084 B |
| JSON, `--provider claude` (6 families) | 22,338 B | 4,038 B |

Build time 13-14 ms for the full sheet (vite-node/tsx, in process). The
MacBook pass measured 65 families / 176 KB / 21.6 KB gzip; this machine has
three more families (68).

The refreshed table was built headlessly from the current
`buildModelRoutes`, `buildUserModelCatalog`, and `buildModelSheet` functions,
the fresh snapshot, and this machine's 131 `ade chat models` entries. It emitted
68 families, all four DeepSeek model IDs on the 1017 family, four Qwen effort
routes on the 0902 build, and no premium/slow quick-kind best-for entries. The
live model-sheet action and CLI formatter were not exercised in this pass; no
dev app was started.

## Jev experiment: numbers vs words as criteria

Same six models (Claude Opus 5.5, Claude Sonnet 5.5, DeepSeek V4.1 Flash,
Gemini 4 Argon, GPT-6 Luna, Kimi K3), eight prompts, one `choice` question per
call to `POST https://opencode.ai/zen/v1/systemone` (`jev-1.13-free`), with the
instruction "Pick the model that should handle this task in a coding agent: the
best fit for the work, not simply the strongest or the cheapest." and the
prompt as `state`.

- **(a) numbers**: each model's criterion is its headline intelligence index,
  Terminal-Bench 4.0, cost per index task and first-token time, e.g. "Claude
  Opus 5.5: intelligence index 53.6; Terminal-Bench 4.0 57%; cost per task
  $1.82; first token 33.7 s".
- **(b) notes**: each model's criterion is its curated summary plus best-for and
  avoid-for kinds with their reasons, from the sheet.

The numbers column below is from run 3. The notes column is one fresh run
(run 4) after the owner’s decisions; the final column preserves runs 1 and 2
from before the earlier Gemini note fix. This pass used the new DeepSeek 1017
notes. All eight requests succeeded; per-call latency was not captured.

| Kind | Prompt (abridged) | (a) numbers, run 3: pick, conf | (a) top 3 | (b) notes, run 4: pick, conf | (b) top 3 | runs 1 / 2 (a · b) |
|---|---|---|---|---|---|---|
| question | What does `git rebase --onto main feature~3 feature` actually do? | **claude-sonnet-5-5** 0.50 | claude-sonnet-5-5 0.58, claude-opus-5-5 0.30, deepseek-v4-1-flash 0.05 | **gpt-6-luna** 0.65 | gpt-6-luna 0.71, claude-sonnet-5-5 0.22, claude-opus-5-5 0.04 | claude-sonnet-5-5 · gpt-6-luna / claude-sonnet-5-5 · gpt-6-luna |
| research | Read the sync service and the cr-sqlite docs and explain why concur… | **claude-sonnet-5-5** 0.40 | claude-sonnet-5-5 0.50, claude-opus-5-5 0.38, gemini-4-argon 0.08 | **claude-opus-5-5** 0.29 | claude-opus-5-5 0.41, kimi-k3 0.41, gemini-4-argon 0.08 | claude-opus-5-5 · kimi-k3 / claude-sonnet-5-5 · claude-opus-5-5 |
| review | Review this 600-line PR diff to the session store for correctness b… | **claude-opus-5-5** 0.52 | claude-opus-5-5 0.60, claude-sonnet-5-5 0.25, gemini-4-argon 0.13 | **gemini-4-argon** 0.77 | gemini-4-argon 0.81, claude-opus-5-5 0.18, claude-sonnet-5-5 0.01 | claude-opus-5-5 · gemini-4-argon / claude-opus-5-5 · gemini-4-argon |
| small_edit | Rename the `isOpen` prop to `open` in Dialog.tsx and its two callers. | **claude-sonnet-5-5** 0.71 | claude-sonnet-5-5 0.76, deepseek-v4-1-flash 0.20, gpt-6-luna 0.02 | **claude-sonnet-5-5** 0.86 | claude-sonnet-5-5 0.88, deepseek-v4-1-flash 0.09, claude-opus-5-5 0.01 | claude-sonnet-5-5 · gemini-4-argon / claude-sonnet-5-5 · gemini-4-argon |
| feature | Add GitHub OAuth sign-in end to end: server routes, token storage, … | **claude-sonnet-5-5** 0.51 | claude-sonnet-5-5 0.59, claude-opus-5-5 0.33, gemini-4-argon 0.06 | **claude-sonnet-5-5** 0.83 | claude-sonnet-5-5 0.86, claude-opus-5-5 0.14, deepseek-v4-1-flash 0.00 | claude-sonnet-5-5 · claude-sonnet-5-5 / claude-sonnet-5-5 · claude-sonnet-5-5 |
| debugging | The brain process deadlocks intermittently under load when two mach… | **claude-opus-5-5** 0.62 | claude-opus-5-5 0.68, claude-sonnet-5-5 0.20, gemini-4-argon 0.10 | **claude-opus-5-5** 0.74 | claude-opus-5-5 0.78, gemini-4-argon 0.20, claude-sonnet-5-5 0.02 | claude-opus-5-5 · claude-opus-5-5 / claude-opus-5-5 · claude-opus-5-5 |
| refactor | Split the 35,000-line cli.ts into modules by command group without … | **claude-opus-5-5** 0.42 | claude-opus-5-5 0.52, claude-sonnet-5-5 0.33, gemini-4-argon 0.12 | **claude-opus-5-5** 0.47 | claude-opus-5-5 0.56, gemini-4-argon 0.31, claude-sonnet-5-5 0.13 | claude-opus-5-5 · claude-opus-5-5 / claude-opus-5-5 · claude-opus-5-5 |
| writing | Write the release notes for v2.3 from these 40 commit messages, gro… | **claude-sonnet-5-5** 0.72 | claude-sonnet-5-5 0.77, claude-opus-5-5 0.11, deepseek-v4-1-flash 0.07 | **claude-sonnet-5-5** 0.63 | claude-sonnet-5-5 0.69, kimi-k3 0.16, gpt-6-luna 0.08 | claude-sonnet-5-5 · claude-sonnet-5-5 / claude-sonnet-5-5 · claude-sonnet-5-5 |

**What changed in the notes run.** The quick question still selects GPT-6 Luna,
review selects Gemini, hard debugging and refactor select Opus, and feature and
release notes select Sonnet. The small rename now selects Sonnet (0.86), with
DeepSeek second (0.09); the revised 1017 notes describe a mid-priced model and
its newer benchmark profile, so the earlier DeepSeek small-edit pick did not
repeat. Research is inconclusive: Opus and Kimi tie at 0.41 in the top three,
while the choice is Opus at 0.29 confidence. This single rerun does not measure
stability.

**Conclusion.** The first-pass numbers run kept Jev mostly between Opus and
Sonnet. The refreshed notes run still distinguishes the quick question, review,
debugging, feature and writing prompts, but changes the one-line rename from
DeepSeek to Sonnet and leaves research close between Opus and Kimi. The revised
DeepSeek note reflects the October build and does not describe it as the cheap
small-edit choice. Treat this eight-call pass as a spot check, not a stability
result.

## Decisions applied (2026-10-20)

- All 17 curated matches are approved in this report. `modelSheetMatches.json`
  has no status field, so its contents are unchanged.
- `qwen3.8-max` maps to `qwen3-8-max-0902` (Qwen3.8 Max 0902, Intelligence
  Index 45.4). `deepseek-v4.1-flash` and its `deepseek-flash` alias map to
  `deepseek-v4-1-flash-1017` (DeepSeek V4.1 Flash 1017, Intelligence Index
  45.1). The fresh registry has one Qwen row with no effort label and one
  measured max DeepSeek row. `buildModelRoutes` creates four Qwen routes on the
  same measured build without effort scaling; DeepSeek’s max route is measured
  directly and its lower/high routes use the router’s existing effort scaling.
  All four DeepSeek model IDs route to the 1017 family, including
  `opencode/deepseek/deepseek-flash`.
- The curated notes now describe the Qwen 0902 and DeepSeek 1017 numbers. The
  sheet enforces the quick-task rule for every family, and the notes were
  rescanned: beyond the five named families, Qwen3.7 Plus and Qwen3-8-2-4T
  A95B also had question recommendations removed because they are slow.
- The sheet scores nine kinds and omits audio scoring. Registry speech data and
  the composer’s separate media hint are unchanged.
