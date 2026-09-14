# Agent instructions — Meridian / QVAC

This is a **QVAC Solutions qualification exercise**: a fictional client
(Meridian Components) and a real on-device AI stack (`@qvac/sdk` on Node.js +
Bare). Read [README.md](README.md) before writing code.

Detailed rules live in [`.agents/rules/`](.agents/rules/). Claude Code also
loads [`.claude/rules/`](.claude/rules/). Cursor also loads
[`.cursor/rules/`](.cursor/rules/).

## Hard constraints

- **No cloud AI APIs.** Inference, embeddings, and retrieval run on-device or
  on a Meridian-controlled peer. Do not call OpenAI, Anthropic, Gemini, or
  similar for model work.
- **Citations are mandatory.** Every grounded answer must point at a corpus
  file. Inventing parts, prices, stock, or customer figures is a product bug.
- **Stack is Node.js + Bare + `@qvac/sdk`.** This is not an Electron app and
  not a Fibiom fork. Use `fibiom-electron` only as a QVAC usage reference.
- **Plugin-scope the SDK.** Declare only the addons this product uses in
  `qvac.config.*`. Do not ship the full SDK surface.
- **Mandatory scope first.** Finish reqs 1–6 before any I.* improvement.
- **Decide, then implement.** Do not one-shot the brief. State assumptions
  and the discovery questions a real engagement would still need.
- **Git is local until asked.** Branch `N-1-do-smth`, commit `N-1: Do smth`.
  Never push unless the user explicitly asks. See
  [`.agents/rules/git-workflow.md`](.agents/rules/git-workflow.md).

## Product decisions you must own

Model choice, chunking, retrieval, failure behavior, and UI are ours to
justify against an 8 GB iGPU laptop, offline plants, and IT’s installer cap.
When unsure, pick the smaller model, the explicit citation, and the local
fallback.
