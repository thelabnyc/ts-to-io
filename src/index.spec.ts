import { describe, expect, test } from "vitest";

import { DEFAULT_FILE_NAME, defaultConfig } from "./config.js";
import { extractFlags } from "./flags.js";
import { getValidatorsFromString } from "./index.js";

const testConfig = {
    ...defaultConfig,
    fileNames: [DEFAULT_FILE_NAME],
    includeHeader: false,
};

describe("Generate io-ts validators", () => {
    test("generates validators for primitive types", () => {
        expect(getValidatorsFromString("type num = number;", testConfig)).toBe(
            "const num = t.number",
        );
        expect(getValidatorsFromString("type str = string;", testConfig)).toBe(
            "const str = t.string",
        );
        expect(getValidatorsFromString("type nil = null;", testConfig)).toBe(
            "const nil = t.null",
        );
    });

    test("generates validators for basic interfaces and object types", () => {
        const inputInterface = `
    interface Test { foo: number, bar: string }
  `;
        const inputObjectType = `
    type Test = { foo: number, bar: string }
  `;
        const result = "const Test = t.type({foo: t.number, bar: t.string})";

        expect(getValidatorsFromString(inputInterface, testConfig)).toBe(
            result,
        );
        expect(getValidatorsFromString(inputObjectType, testConfig)).toBe(
            result,
        );
    });

    test("generates validators for interfaces with optional fields", () => {
        expect(
            getValidatorsFromString(
                "interface Test { foo: string, bar?: number }",
                testConfig,
            ),
        ).toBe(
            "const Test = t.intersection([t.type({foo: t.string}), t.partial({bar: t.union([t.undefined, t.number])})])",
        );
    });

    test("generates validators for arrays", () => {
        expect(getValidatorsFromString("type arr = string[]", testConfig)).toBe(
            "const arr = t.array(t.string)",
        );
        expect(
            getValidatorsFromString(
                "type arr = Array<{foo: string}>",
                testConfig,
            ),
        ).toBe("const arr = t.array(t.type({foo: t.string}))");
    });

    test("generates validators for record types", () => {
        expect(
            getValidatorsFromString(
                "type rec = Record<number, string>",
                testConfig,
            ),
        ).toBe("const rec = t.record(t.number, t.string)");
        expect(
            getValidatorsFromString(
                "type rec = Record<string, null>",
                testConfig,
            ),
        ).toBe("const rec = t.record(t.string, t.null)");
    });

    test("generates validators for union types", () => {
        expect(
            getValidatorsFromString("type un = string | number", testConfig),
        ).toBe("const un = t.union([t.string, t.number])");
        expect(
            getValidatorsFromString(
                "type un = string | number | { foo: string }",
                testConfig,
            ),
        ).toBe(
            "const un = t.union([t.string, t.number, t.type({foo: t.string})])",
        );
    });

    test("optimizes validator for string literal union types", () => {
        expect(
            getValidatorsFromString("type un = 'foo' | 'bar'", testConfig),
        ).toBe('const un = t.keyof({"foo": null, "bar": null})');
    });

    test("generates validators for intersection types", () => {
        expect(
            getValidatorsFromString(
                "type inter = { foo: string } | { bar: number } | { foo: number }",
                testConfig,
            ),
        ).toBe(
            "const inter = t.union([t.type({foo: t.string}), t.type({bar: t.number}), t.type({foo: t.number})])",
        );
    });

    test("generates validators for function types", () => {
        expect(
            getValidatorsFromString("type fn = () => void", testConfig),
        ).toBe("const fn = t.Function");
        expect(
            getValidatorsFromString(
                "type fn = (s: string, n: number) => (b: boolean) => object",
                testConfig,
            ),
        ).toBe("const fn = t.Function");
    });

    test("generates validators for literal types", () => {
        expect(getValidatorsFromString('type foo = "foo"', testConfig)).toBe(
            'const foo = t.literal("foo")',
        );
        expect(getValidatorsFromString("type one = 1", testConfig)).toBe(
            "const one = t.literal(1)",
        );
        expect(getValidatorsFromString("type f = false", testConfig)).toBe(
            "const f = t.literal(false)",
        );
    });

    test("generates validators for tuple types", () => {
        expect(
            getValidatorsFromString("type foo = [number, string]", testConfig),
        ).toBe("const foo = t.tuple([t.number,t.string])");
    });

    test("handles nullable types correctly", () => {
        expect(
            getValidatorsFromString(
                'type foobar = "foo" | "bar" | null',
                testConfig,
            ),
        ).toBe(
            'const foobar = t.union([t.null, t.literal("foo"), t.literal("bar")])',
        );
    });

    test("should use references instead of inlining interface types", () => {
        const input = `
      interface Person {
        name: string;
      }

      interface PersonGroup {
        name: string;
        members: Person[];
      }
    `;

        const expected = `const Person = t.type({name: t.string})

const PersonGroup = t.type({name: t.string, members: t.array(Person)})`;

        expect(getValidatorsFromString(input, testConfig)).toBe(expected);
    });

    test("should use references for out-of-order interface declarations", () => {
        const input = `
      interface PersonGroup {
        name: string;
        members: Person[];
      }

      interface Person {
        name: string;
      }
    `;

        const expected = `const Person = t.type({name: t.string})

const PersonGroup = t.type({name: t.string, members: t.array(Person)})`;

        expect(getValidatorsFromString(input, testConfig)).toBe(expected);
    });

    test("should handle type alias dependencies correctly", () => {
        const input = `
      interface Person {
        name: Name;
      }

      interface FirstName {
        first_name: string;
      }

      interface LastName {
        last_name: string;
      }

      type Name = FirstName & LastName;
    `;

        const expected = `const FirstName = t.type({first_name: t.string})

const LastName = t.type({last_name: t.string})

const Name = t.intersection([FirstName, LastName])

const Person = t.type({name: Name})`;

        expect(getValidatorsFromString(input, testConfig)).toBe(expected);
    });
});

describe("Configuration", () => {
    test("includeHeader", () => {
        expect(getValidatorsFromString("type a = number;", testConfig)).toBe(
            "const a = t.number",
        );
        expect(
            getValidatorsFromString("type a = number;", {
                ...testConfig,
                includeHeader: true,
            }),
        ).toBe('import * as t from "io-ts"\n\nconst a = t.number');
    });
});

describe("Internals", () => {
    test("gets binary flags", () => {
        expect(extractFlags(0)).toEqual([]);
        expect(extractFlags(1)).toEqual([1]);
        expect(extractFlags(10)).toEqual([8, 2]);
        expect(extractFlags(100)).toEqual([64, 32, 4]);
        expect(extractFlags(67108864)).toEqual([67108864]);
    });
});

describe("Newtype mode", () => {
    const newtypeConfig = {
        ...testConfig,
        newtypeMode: "all" as const,
    };

    test("generates newtype for string primitive alias", () => {
        const input = `export type Latitude = string;`;
        const expected = `export interface Latitude extends Newtype<{ readonly Latitude: unique symbol }, string> {}
export const Latitude = fromNewtype<Latitude>(t.string)
export const isoLatitude = iso<Latitude>()`;
        expect(getValidatorsFromString(input, newtypeConfig)).toBe(expected);
    });

    test("generates newtype for number primitive alias", () => {
        const input = `export type Meters = number;`;
        const expected = `export interface Meters extends Newtype<{ readonly Meters: unique symbol }, number> {}
export const Meters = fromNewtype<Meters>(t.number)
export const isoMeters = iso<Meters>()`;
        expect(getValidatorsFromString(input, newtypeConfig)).toBe(expected);
    });

    test("generates newtype for boolean primitive alias", () => {
        const input = `export type IsActive = boolean;`;
        const expected = `export interface IsActive extends Newtype<{ readonly IsActive: unique symbol }, boolean> {}
export const IsActive = fromNewtype<IsActive>(t.boolean)
export const isoIsActive = iso<IsActive>()`;
        expect(getValidatorsFromString(input, newtypeConfig)).toBe(expected);
    });

    test("preserves type reference in interface property", () => {
        const input = `
export type Latitude = string;
export interface Point {
    lat: Latitude;
}
`;
        const result = getValidatorsFromString(input, newtypeConfig);
        expect(result).toContain("lat: Latitude");
    });

    test("handles union with newtype", () => {
        const input = `
export type Latitude = string;
export interface Point {
    lat: Latitude | null;
}
`;
        const result = getValidatorsFromString(input, newtypeConfig);
        expect(result).toContain("t.union([Latitude, t.null])");
    });

    test("generates multiple newtypes", () => {
        const input = `
export type Latitude = string;
export type Longitude = string;
`;
        const result = getValidatorsFromString(input, newtypeConfig);
        expect(result).toContain("interface Latitude");
        expect(result).toContain("interface Longitude");
        expect(result).toContain("fromNewtype<Latitude>(t.string)");
        expect(result).toContain("fromNewtype<Longitude>(t.string)");
    });

    test("includes newtype imports when newtypeMode is all", () => {
        const input = `export type Latitude = string;`;
        const result = getValidatorsFromString(input, {
            ...newtypeConfig,
            includeHeader: true,
        });
        expect(result).toContain('import * as t from "io-ts"');
        expect(result).toContain(
            'import { fromNewtype } from "io-ts-types/lib/fromNewtype"',
        );
        expect(result).toContain('import { Newtype, iso } from "newtype-ts"');
    });

    test("does not include newtype imports when no newtypes are generated", () => {
        const input = `export interface Point { x: number; y: number; }`;
        const result = getValidatorsFromString(input, {
            ...newtypeConfig,
            includeHeader: true,
        });
        expect(result).toContain('import * as t from "io-ts"');
        expect(result).not.toContain("fromNewtype");
        expect(result).not.toContain("newtype-ts");
    });

    test("does not convert complex type aliases to newtypes", () => {
        const input = `export type StringOrNumber = string | number;`;
        const result = getValidatorsFromString(input, newtypeConfig);
        expect(result).not.toContain("Newtype");
        expect(result).toContain("t.union([t.string, t.number])");
    });

    test("backward compatibility - newtypeMode none", () => {
        const input = `
export type Latitude = string;
export interface Point {
    lat: Latitude;
}
`;
        const noneConfig = {
            ...testConfig,
            newtypeMode: "none" as const,
        };
        const result = getValidatorsFromString(input, noneConfig);
        expect(result).not.toContain("Newtype");
        expect(result).toContain("const Latitude = t.string");
    });
});
