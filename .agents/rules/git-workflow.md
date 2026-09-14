# Git workflow

Number work sequentially. The human form is `N: Do smth` (example:
`1: Add agent rules and project brief`).

Git **forbids** `:` and spaces in branch names, so the branch is the same
number in kebab-case: `N-do-smth` (example: `1-add-agent-rules-and-brief`).

- Create a new local branch for each slice of work. Do not pile unrelated
  changes onto `main`.
- Commit message subject uses the human form: `N: Imperative summary`.
- One concern per commit when practical. Do not mix product code with
  unrelated rule or docs churn.
- **Local only.** Never `git push`, never set a remote tracking branch, never
  open a PR unless the user explicitly asks.
- Never `--force` push, never skip hooks, never amend a commit that is not
  yours from this conversation.
