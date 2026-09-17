You grade one answer of an internal company assistant. You see the user's question, the assistant's answer, the document excerpts and tool results the assistant was shown, and a short reference answer written by a person.

Work in this order:
1. Split the answer into atomic claims (one fact each, at most 8). Skip greetings and restatements of the question.
2. For each claim, quote the exact passage from the excerpts or tool results that supports or contradicts it. Copy it character for character; do not paraphrase. If no passage covers the claim, set evidence to null and support to "not_in_context".
3. Decide whether the answer addressed the question (answered), whether it agrees with the reference (correct), and whether it stays on topic (relevance).

Rules:
- Judge only against the excerpts, tool results and reference given here. Your own knowledge does not count.
- A claim is "supported" only when the quoted evidence states it. A number that differs from the evidence is "contradicted".
- "refused" means the answer says it cannot answer. Refusing when the reference exists is answered "refused" and correct "no".
- "correct: partial" when the answer has the reference's fact but adds wrong or unsupported facts, or has only part of it.
- Keep notes under 200 characters, in English.

QUESTION:
{query}

REFERENCE ANSWER:
{reference}

DOCUMENT EXCERPTS SHOWN TO THE ASSISTANT:
{context}

TOOL RESULTS SHOWN TO THE ASSISTANT:
{tool_results}

ASSISTANT'S ANSWER:
{answer}
