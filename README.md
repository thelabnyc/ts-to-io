# @thelabnyc/ts-to-io

Converts TypeScript type and interface definitions into [io-ts](https://github.com/gcanti/io-ts) type validators.

## Usage

## As a script

```bash
npm install -g @thelabnyc/ts-to-io
ts-to-io file.ts
```

or

```bash
npx @thelabnyc/ts-to-io file.ts
```

### From code

NOTE: The validator generation is not intended to be performed at runtime. You should first generate the validators locally and then include them in the program source.

```typescript
import { getValidatorsFromString } from "@thelabnyc/ts-to-io";

const sourceString = `
  type Person = { name: string; age: number | null }
`;

const validators = getValidatorsFromString(sourceString);
```

## Configuration

ts-to-io supports the following config options

| Key             | CLI opt               | Default | Description                                          |
| --------------- | --------------------- | ------- | ---------------------------------------------------- |
| `followImports` | `--follow-imports`    | `false` | output codecs for types declared in imported files   |
| `includeHeader` | `--no-include-header` | `true`  | omit io-ts import from the output                    |
| `newtypeMode`   | `--newtype-mode`      | `none`  | newtype generation mode: `none` or `all` (see below) |

## Newtype Mode

When `newtypeMode` is set to `all`, primitive type aliases are converted to [newtype-ts](https://github.com/gcanti/newtype-ts) nominal types, providing type safety for distinguishing between different uses of the same primitive type.

### Example

```typescript
// Input
export type Latitude = string;
export type Longitude = string;
export interface Location {
    lat: Latitude;
    lng: Longitude;
}
```

**With `newtypeMode: 'none'` (default):**

```typescript
import * as t from "io-ts";

const Latitude = t.string;
const Longitude = t.string;
const Location = t.type({ lat: t.string, lng: t.string });
```

**With `newtypeMode: 'all'`:**

```typescript
import * as t from "io-ts";
import { fromNewtype } from "io-ts-types/lib/fromNewtype";
import { Newtype, iso } from "newtype-ts";

export interface ILatitude
    extends Newtype<{ readonly ILatitude: unique symbol }, string> {}
export const Latitude = fromNewtype<ILatitude>(t.string);
export const isoLatitude = iso<ILatitude>();

export interface ILongitude
    extends Newtype<{ readonly ILongitude: unique symbol }, string> {}
export const Longitude = fromNewtype<ILongitude>(t.string);
export const isoLongitude = iso<ILongitude>();

const Location = t.type({ lat: Latitude, lng: Longitude });
```

### CLI Usage

```bash
ts-to-io --newtype-mode all input.ts
```

### Programmatic Usage

```typescript
import { defaultConfig, getValidatorsFromString } from "@thelabnyc/ts-to-io";

const validators = getValidatorsFromString(sourceString, {
    ...defaultConfig,
    newtypeMode: "all",
});
```

### Peer Dependencies

When using `newtypeMode: 'all'`, the following peer dependencies are required:

- `io-ts-types` (^0.5.19)
- `newtype-ts` (^0.3.4)
- `fp-ts` (^2.16.0)

## Supported types

| Type            | Supported | TypeScript                         | codec                           |
| --------------- | --------- | ---------------------------------- | ------------------------------- |
| string          | ✅        | `string`                           | `t.string`                      |
| number          | ✅        | `number`                           | `t.number`                      |
| boolean         | ✅        | `boolean`                          | `t.boolean`                     |
| null            | ✅        | `null`                             | `t.null`                        |
| undefined       | ✅        | `undefined`                        | `t.undefined`                   |
| void            | ✅        | `void`                             | `t.void`                        |
| any, unknown    | ✅        | `any`, `unknown`                   | `t.unknown`                     |
| array           | ✅        | `Array<A>`                         | `t.array(A)`                    |
| record          | ✅        | `Record<K, A>`                     | `t.record(K, A)`                |
| object type     | ✅        | `{ name: string }`                 | `t.type({ name: t.string })`    |
| interface       | ✅        | `interface I { name: string }`     | `t.type({ name: t.string })`    |
| literal         | ✅        | `'ABC'`                            | `t.literal('ABC')`              |
| partial         | ✅        | `Partial<{ name: string }>`        | `t.partial({ name: t.string })` |
| readonly        | ❌        | `Readonly<A>`                      | -                               |
| readonly array  | ❌        | `ReadonlyArray<A>`                 | -                               |
| tuple           | ✅        | `[ A, B ]`                         | `t.tuple([ A, B ])`             |
| tuple with rest | ❌        | `[ A, B, ...C ]`                   | -                               |
| union           | ✅        | `A \| B`                           | `t.union([ A, B ])`             |
| intersection    | ✅        | `A & B`                            | `t.intersection([ A, B ])`      |
| keyof           | ❌        | `keyof M`                          | -                               |
| recursive type  | ❌        | `type Node = { children: Node[] }` | -                               |
| function        | ✅        | `type fn = () => string`           | `t.Function`                    |
