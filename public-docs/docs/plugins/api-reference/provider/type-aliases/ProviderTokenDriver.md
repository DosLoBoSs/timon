
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderTokenDriver

> **ProviderTokenDriver** = `object`

## Properties

### ttlMs?

> `readonly` `optional` **ttlMs?**: `number`

## Methods

### args()

> **args**(): `string`[]

#### Returns

`string`[]

***

### env()

> **env**(`dir`, `base`): `Record`\<`string`, `string`\>

#### Parameters

##### dir

`string`

##### base

`Readonly`\<`Record`\<`string`, `string`\>\>

#### Returns

`Record`\<`string`, `string`\>

***

### parse()

> **parse**(`output`): \{ `kind`: `"paste-code"`; `url`: `string`; \} \| `null`

#### Parameters

##### output

`string`

#### Returns

\{ `kind`: `"paste-code"`; `url`: `string`; \} \| `null`

***

### rejected()

> **rejected**(`output`): `boolean`

#### Parameters

##### output

`string`

#### Returns

`boolean`

***

### save()

> **save**(`token`): `void`

#### Parameters

##### token

`string`

#### Returns

`void`

***

### stored()

> **stored**(): `boolean`

#### Returns

`boolean`

***

### token()

> **token**(`output`): `string` \| `null`

#### Parameters

##### output

`string`

#### Returns

`string` \| `null`
