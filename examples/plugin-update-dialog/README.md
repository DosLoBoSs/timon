# plugin-update-dialog

Replaces Timon's update window (client API 17): the window that **Update**
opens, from the update card at the bottom left and from Settings › System ›
Updates. This one is compact: the version, its highlights on one line each,
the download as a percentage, and the gestures in one row.

`updates.dialog` is a single slot declared at startup. Timon's own window is
the fallback and comes back as soon as the plugin is removed.

The component takes no props: it reads `useUpdateDialog()` from `@timon/ui` —
the `version` and its `publishedAt` date, the `highlights` written by hand at
the release (plain text, at most five, possibly none), `notesUrl`, the desktop
app's `download`, the `step` the update flow is at with its `line`, `command`
and `alert`, the `actions` of that step and `close()`. Timon keeps the dialog
around it and runs the flow: the download, its verification, the running
missions asked about first, then the installation. What a plugin must respect
is in [Slots](../../public-docs/docs/plugins/slots.md), under `updates.dialog`.

The package deliberately ships no `SIGNATURE` file.
