# plugin-notice

Shows how a plugin uses the bottom-left notice cards of Timon (client API 17):

- it pushes a card of its own with `ctx.notices.push({ id, tone, icon?, title, body?, actions?, dismissible })`
  from `apply`; `icon` names a logo the app draws itself (`github`, `discord`,
  `timon`, `x`, `youtube`), never an image address, and without it the card
  shows its tone's icon; `ctx.notices.remove(id)` takes it away, and a card the person
  closes stays closed for their account, on every client;
- it replaces how every card is painted (slot `notices.card`) with one compact
  line. The product's card comes back as soon as the plugin is removed.

The card component takes no props: it reads `useNotice()` from `@timon/ui` —
the `notice` (`title`, `body`, `tone`, `icon`, `actions`, `dismissible`) and its two
gestures, `dismiss()` and `act(index)`. The host keeps the frame: the stack at
the bottom left, at most three cards, warnings first, and what was closed.

A card that depends on React state (a version, a count of days) comes from an
entry of the `notices` slot instead: a component mounted once, painting
nothing, that pushes with `useNotices()`. What a plugin must respect is in
[Slots](../../public-docs/docs/plugins/slots.md), under `notices`.

The package deliberately ships no `SIGNATURE` file.
