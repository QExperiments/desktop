# Non-negotiables

Meridian killed a cloud assistant because customer names and pipeline data
leaked, and because cost / margin were unclear. Do not recreate that failure.

- No third-party AI service sees prompts, corpus, embeddings, audio, or images.
- Inference may run locally or on a **Meridian-controlled** peer only.
- `start` (the eval server) must work with outbound network blocked.
- Model weights are downloaded/cached at setup time, not baked into the
  installer. Target the weakest fleet device: 2019 laptop, iGPU, 8 GB RAM.
- Ingest `corpus.zip` as given. Do not rewrite, summarize, or “clean” it
  before indexing.
- If the corpus does not contain the answer, say so. Do not guess a number.
- Finish mandatory requirements before extras (`I.1`–`I.6`).
- Write down assumptions and the questions you would still ask Dana (COO)
  and Raj (IT/Security). Prefer a short honest question list over a confident
  guess.
