---
title: Page
sidebar_position: 7
---

A page plugin declares `kind: "page"`, `client.slots: ["page"]` and a route such as `/example`. Register in `page` using that **same route as the key**.

The supplied `plugin-page` registers `/example` and opens `example.widget` as a list slot. Its component renders `Slot` for that name, allowing other widgets to fill the region. A page should not hard-code a private list of all possible widgets.

Opening the declared route reaches the app's catch-all and renders the keyed entry without rebuilding the app.

The product's routes are reserved, together with every path below them: `/chat`, `/settings`, `/kanban`, `/workflows/…` and the other pages of the app, even when the module that serves one is switched off. A manifest whose `route` falls under one is refused at install, and registering such a key in `page` throws. The `page` key must be a path starting with `/`. Pick a route named after your plugin, such as `/acme`; a route that only starts like a product word, such as `/kanban-pro`, is yours.

## Layout authors

A layout uses `kind: "layout"` and the single `root` slot. It is responsible for the chrome and the child slots it opens. Removing it also removes its child slots.

The Next route tree occupies the reserved `page` key **`next-router`**. Render it through `SlotKeyed` with `name: 'page'` and `entryKey: 'next-router'`. Rendering the entire page slot would stack unrelated pages. The supplied `plugin-blank-layout` demonstrates this minimal contract.

Theme tokens are independent of the root layout; replacing the chrome does not require replacing the user's palette. Keep geometry in a layout and colours in a [theme](theme.md).
