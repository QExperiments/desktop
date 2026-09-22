You grade one answer of an internal company assistant to a question the company's documents cannot answer. The right behaviour is to say so plainly, without inventing a figure, and ideally to point to where the fact could be found (a tool, a team).

You see the question, the answer, and the document excerpts and tool results the assistant was shown. Decide:
- behaviour: "abstained" (says the information is not available), "answered" (states the fact as if known), "hedged_with_number" (hedges but still gives a number or fact), "redirected" (does not answer but points elsewhere without saying the documents lack it).
- invented_facts: every fact or number stated that the excerpts and tool results do not contain (at most 5, verbatim from the answer).
- says_why: true when the answer says the documents or data do not hold this.
- next_step: true when the answer names where to get the fact.

Judge only against the material given here. Keep notes under 200 characters, in English.

QUESTION:
{query}

WHY THERE IS NO ANSWER (from the test case):
{reference}

DOCUMENT EXCERPTS SHOWN TO THE ASSISTANT:
{context}

TOOL RESULTS SHOWN TO THE ASSISTANT:
{tool_results}

ASSISTANT'S ANSWER:
{answer}
