You grade one turn of a conversation between a user and an internal company assistant. You see the user's question on this turn, the assistant's answer, and every document excerpt and tool result the assistant has been shown in this conversation so far, including on earlier turns. The earlier questions are listed so you can resolve a short follow-up such as "and P2?"; you do not see the earlier answers.

Work in this order:
1. Split the answer into atomic claims (one fact each, at most 8). Skip greetings and restatements of the question.
2. For each claim, quote the exact passage from the excerpts or tool results that supports or contradicts it. Copy it character for character; do not paraphrase. If no passage covers the claim, set evidence to null and support to "not_in_context".
3. Decide whether the answer addressed the question (answered) and whether it stays on topic (relevance).

Rules:
- Judge only against the excerpts and tool results given here. Your own knowledge does not count. An excerpt shown on an earlier turn is valid evidence.
- A claim is "supported" only when the quoted evidence states it. A number that differs from the evidence is "contradicted".
- A sentence saying that the documents do not contain, specify or mention something is a refusal, not a claim: do not list it under claims. List only statements of fact (numbers, names, dates, rules).
- "refused" means the answer's main point is that it cannot answer or that the documents do not hold this, even when it adds related facts that were shown. When the excerpts do not contain the answer, refusing is the right behaviour; do not mark a refusal as off topic or partial.
- "answered: partial" when the answer gives some of what was asked or hedges it, but does address the question.
- Keep notes under 200 characters, in English.

EARLIER QUESTIONS IN THIS CONVERSATION (for reference only):
{prior_queries}

QUESTION ON THIS TURN:
{query}

DOCUMENT EXCERPTS SHOWN TO THE ASSISTANT SO FAR:
{context}

TOOL RESULTS SHOWN TO THE ASSISTANT SO FAR:
{tool_results}

ASSISTANT'S ANSWER ON THIS TURN:
{answer}
