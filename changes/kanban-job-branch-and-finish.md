---
type: added
---
A Kanban job can start from a branch the repository already has and stay on its branch instead of being merged, and a project that merges locally can run a job on a branch of its own, merged into `main` by a final task (`timon task create --landing local`). A branch kept this way lands later with `timon pr land`: merged into the local target, or its pull request opened.
