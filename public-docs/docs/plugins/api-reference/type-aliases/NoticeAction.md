
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: NoticeAction

> **NoticeAction** = `object`

One button of a notice card (client API 16). `href`: a page of the app
(`/settings`) or an `https:` / `http:` address, opened in a new window.
`dismiss`: the click also closes the card for good, as its × does. An
action needs at least one of `onSelect`, `href`, `dismiss: true`.

## Properties

### dismiss?

> `optional` **dismiss?**: `boolean`

***

### href?

> `optional` **href?**: `string`

***

### label

> **label**: `string`

***

### onSelect?

> `optional` **onSelect?**: () => `void`

#### Returns

`void`
