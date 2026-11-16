
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: NoticeInput

> **NoticeInput** = `object`

A bottom-left notice card (client API 16): not a toast, it stays until an
action or its × takes it away. `id`: 1-96 letters, digits, `.`, `_`, `:` or
`-`, scoped to the plugin; carry a version in it for a card that must come
back for each version. `title` up to 120 characters, `body` up to 400, both
plain text; two actions at most, labels up to 40. `tone` defaults to `info`,
`dismissible` to `true`: closing is remembered for the account, on every
client.

## Properties

### actions?

> `optional` **actions?**: readonly [`NoticeAction`](NoticeAction.md)[]

***

### body?

> `optional` **body?**: `string`

***

### dismissible?

> `optional` **dismissible?**: `boolean`

***

### id

> **id**: `string`

***

### title

> **title**: `string`

***

### tone?

> `optional` **tone?**: [`NoticeTone`](NoticeTone.md)
