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

| Key             | CLI opt               | Default | Description                                        |
| --------------- | --------------------- | ------- | -------------------------------------------------- |
| `followImports` | `--follow-imports`    | `false` | output codecs for types declared in imported files |
| `includeHeader` | `--no-include-header` | `true`  | omit io-ts import from the output                  |

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
