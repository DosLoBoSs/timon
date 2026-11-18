---
title: Land a job through a pull request
sidebar_position: 4.2
---

By default a Kanban job lands locally: each task's branch is merged into its base branch on your machine. A project whose main branch is protected, or shared with a team, can land its jobs through a pull request instead. The job's tasks merge into one integration branch (`feat/<topic>`) cut from the remote's target branch, and Timon opens a single pull request for it once the work is done. Merging that pull request stays your gesture, on the forge.

GitHub is the only forge Timon opens pull requests on for now, through the GitHub CLI (`gh`), which must be installed and signed in on the machine where Timon's daemon runs.

## Set up the project

```bash
timon project set-integration my-app --mode pr --account my-bot \
  --remote-url git@github.com:my-org/my-app.git \
  --gh-config-dir /home/me/.config/gh-my-bot
timon project get-integration my-app --check
```

- `--account`: the GitHub login `gh` must be signed in as. Timon refuses to push when `gh` answers another one.
- `--remote-url`: the push URL the project's remote (`origin` unless `--remote` says otherwise) must have. A remote that points elsewhere is refused.
- `--gh-config-dir` (optional): a `gh` configuration folder kept for this project, inside your home folder and outside every project folder. Without it, `gh` uses its default sign-in.
- `--target` (default `main`) and `--branch-prefix` (default `feat/`) name the target branch and the prefix of the integration branches.

`--check` asks `gh` which account it signs in as, so you can confirm the setting before any job runs.

## Open the pull request

When the job's work is merged into its integration branch, the agent (or you) asks Timon to open the pull request:

```bash
timon pr open <task-id|series-id> --title "Add CSV export" --body-file pr.md
```

Agents use the `pr_open` tool, which does the same. The title and the description are written by whoever calls it; the account, the remote and the target come from the project's setting.

Before anything leaves your machine, Timon checks the branch. If one check fails, nothing is pushed and the answer lists every check with its result:

| Check | Refused when |
| --- | --- |
| Account | `gh` is signed in as another account than the project's, or cannot answer |
| Remote URL | the remote does not push to the URL the project expects |
| Identity | a commit of the branch was not authored and committed with the repository's `user.name` and `user.email` |
| Messages | a commit message, the title or the description carries a task id or an internal TODO number; the title and the description also carry no attribution line |
| Ignored files | the branch adds a file your `.gitignore` covers (a folder that must stay private, force-added by mistake) |
| Public tree | the repository has a `docs/oss/check-public-tree.mjs` script and it reports a blocker; without the script this check is skipped and says so |
| Remote branch | the branch already exists on the remote and has commits the local one does not contain |

Then Timon pushes the integration branch and opens the pull request. The push is never forced: a branch already on the remote only moves forward, and one that moved on its own is never overwritten. Merge it into your local branch, then run the command again.

A branch under embargo (`sec/<topic>`, for a security fix) is never pushed by this command, whatever the setting says: it lands by hand once the advisory is published.

If the push succeeds but the pull request cannot be created, run the command again: the branch is already there and only the pull request is opened.
