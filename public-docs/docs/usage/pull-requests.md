---
title: Land a job through a pull request
sidebar_position: 4.2
---

By default a Kanban job lands locally: each task's branch is merged into its base branch on your machine. A project whose main branch is protected, or shared with a team, can land its jobs through a pull request instead. The job's tasks merge into one integration branch (`feat/<topic>`) cut from the remote's target branch, and Timon opens a single pull request for it once the work is done. Merging that pull request stays your gesture, on the forge.

GitHub is the only forge Timon opens pull requests on for now, through the GitHub CLI (`gh`), which must be installed and signed in on the machine where Timon's daemon runs.

## Set up the project

### From the app

Open the project's window (**Edit** on its card): under **Integrations**, the **Pull requests** row says how the project's jobs land, **Jobs merge locally** or the target branch and account of its pull requests (`Pull request to origin/main · account my-bot`). **Set up** (**Configure** once it is on) opens the fields:

- **Remote** and **Push URL of the remote**: pick one of the repository's remotes; the URL it pushes to is filled in for you. A remote that later points elsewhere is refused.
- **Target branch** (`main` by default) and **Branch prefix** (`feat/` by default).
- **GitHub account**: the login `gh` must be signed in as.
- **gh configuration folder** (optional): a `gh` configuration folder kept for this project, inside your home folder and outside every project folder.

**Check** asks `gh` which account it signs in as with the account and folder you typed, before anything is saved, and says why it could not answer (`gh` missing, not signed in, a folder Timon refuses). **Turn on** saves the setting. The row's menu (**…**) checks `gh`'s sign-in again later, and **Go back to the local merge** clears the setting.

The row and its fields are for accounts that hold the `projects:manage` permission: the setting names a folder of your machine and the account Timon pushes as. Without it, the row says so and its action is greyed.

### From the command line

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

## How the project's jobs run

Once the project is in `pr` mode, its jobs land through a pull request and nothing of them is merged into the target branch on your machine:

- When you plan a job with an agent (the Kanban planner), Timon names the job's integration branch after the job's title, `feat/add-csv-export` for "Add CSV export" (with `-2`, `-3`… when an earlier job already used the name), or after the name the agent proposes, and every task of the job starts from it. In the planner, **Advanced** shows that name: you can change it before you launch the job (the project's prefix, `feat/`, is added for you). Timon checks the name as you type and says why one cannot be used (an id in it, a name reserved for Timon's own branches, the target branch itself, a name git refuses). Once a task of the job has started, the branch exists and its name is fixed: planning the same job again shows it read-only.
- When the first task starts, Timon creates that branch from the remote's target branch (`origin/main`), without touching your checkout. If the remote cannot be reached, the task is blocked with the reason instead of starting from your local `main`.
- Reviews and merges run as usual, into the integration branch.
- The plan ends with a final task, **Pull request — <job title>**. It starts once every part of the job is merged into the branch: an agent brings the target branch in if it has moved, writes the title and the description, and opens the pull request as described below. The task is done as soon as the pull request is open; you review and merge it on the forge.

A task you create by hand in such a project without a base branch gets an integration branch named after its own title. A task whose base is the target branch itself (`main`) is blocked: in this mode no work starts from it. To add the final task by hand:

```bash
timon task create --type merge --landing pr --agent my-app.merger --base feat/add-csv-export \
  --deps <ids of the code tasks> --title "Pull request — Add CSV export"
```

Jobs already under way keep the mode they started with: changing the setting, or going back to the local merge with `timon project set-integration my-app --reset`, applies to the next jobs.

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

Timon then adds to the description a `Fixes` or `Refs` line for each GitHub issue of the job's ideas ([The issue, the pull request and the comment](git.md#the-issue-the-pull-request-and-the-comment)).

Then Timon pushes the integration branch and opens the pull request. The push is never forced: a branch already on the remote only moves forward, and one that moved on its own is never overwritten. Merge it into your local branch, then run the command again.

A branch under embargo (`sec/<topic>`, for a security fix) is never pushed by this command, whatever the setting says: it lands by hand once the advisory is published.

If the push succeeds but the pull request cannot be created, run the command again: the branch is already there and only the pull request is opened.

## Follow the job and review contributors

The [Git stack](git.md) of an agent's chat follows what happens next. **Jobs** groups the project's jobs by what they wait for (a failing check or a conflict first) and previews what each pull request carries; **Pull requests** lists the pull requests open on the repository, contributors' ones included, and prepares their review without running their code. On a TO DO idea, the badge of its job opens the same preview. See [Pull requests](git.md#pull-requests), [Jobs](git.md#jobs) and [From the TO DO notebook](git.md#from-the-to-do-notebook).
