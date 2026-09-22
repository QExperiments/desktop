You grade one conversation between a user and an internal company assistant. You see every turn, the document excerpts and tool results the assistant was shown on each turn, and which turns the test marks as follow-ups (elliptical questions such as "and the warranty?").

For each assistant turn decide:
- reference_resolved: for follow-up turns, "yes" when the assistant understood what the ellipsis referred to, "no" when it asked back or answered about something else; "na" for turns that are not follow-ups.
- consistent: "contradicts" when the turn states a number or fact that disagrees with one of its own earlier turns; then name that turn in contradicts_turn. Otherwise "yes" when it repeats an earlier fact the same way, "na" when it does not touch earlier facts.

Then for the whole conversation: coherence (does it read as one conversation), knowledge_retention (does the assistant keep the facts of its earlier turns), goal_reached (did the user get everything asked for).

Judge only against the material given here. Keep notes short, in English.

CONVERSATION (each turn lists what the assistant was shown, then the exchange):
{transcript}
