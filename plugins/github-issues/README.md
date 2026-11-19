# GitHub issues

Built-in Timon plugin, written on the public plugin SDK only (`ctx.forge`,
`ctx.kanban.todos`, `ctx.storage`): no `gh`, no account, no token of its own.

It lists the open issues of a project's GitHub repository that carry the
project's label (`accepted` by default) and turns the one a person picks into
an idea of the TO DO notebook, once. Nothing is imported on its own, and
nothing is written on GitHub.

- `GET candidates?project=<slug>`: the labelled open issues, each with the
  idea it became (`todo`, and its pull request once there is one).
- `POST import { project, issue }`: one issue, one idea. The idea links to the
  issue (`github`, `owner/repo#n`); a second import answers the same idea.
- `GET project?project=<slug>`, `PUT project { project, label }`: the
  project's label (`label: null` goes back to the plugin's setting).
- `POST dismiss { project, issue, hidden? }`: hides an issue from the list.

Every route needs a signed-in account allowed to manage projects. The text of
an issue was written by someone else: the idea's notes keep it inside an
`<untrusted-data>` block, as bounded JSON, under a line saying it is data.

Built in and enabled by default (`orchestrator/builtin-plugins.json`).
User guide: `public-docs/docs/usage/git.md`.
