/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import * as ts from "typescript";

import { extractFlags } from "./flags.js";

/**
 * Checks if a TypeScript type is an object type.
 */
export function isObjectType(type: ts.Type): type is ts.ObjectType {
    return extractFlags(type.flags).includes(ts.TypeFlags.Object);
}

/**
 * Checks if a TypeScript type is a primitive type (string, number, boolean, null, or undefined).
 */
export function isPrimitiveType(type: ts.Type): boolean {
    return extractFlags(type.flags).some((flag) =>
        [
            ts.TypeFlags.String,
            ts.TypeFlags.Number,
            ts.TypeFlags.Boolean,
            ts.TypeFlags.Null,
            ts.TypeFlags.Undefined,
        ].includes(flag),
    );
}

/**
 * Checks if a TypeScript type is any or unknown.
 */
export function isAnyOrUnknown(type: ts.Type): boolean {
    return extractFlags(type.flags).some((f) =>
        [ts.TypeFlags.Any, ts.TypeFlags.Unknown].includes(f),
    );
}

/**
 * Checks if a TypeScript type is void.
 */
export function isVoid(type: ts.Type): boolean {
    return extractFlags(type.flags).includes(ts.TypeFlags.Void);
}

/**
 * Checks if a TypeScript type is a tuple type.
 */
export function isTupleType(type: ts.Type): type is ts.TupleType {
    const target = (type as ts.TupleTypeReference).target;
    return target && typeof target.hasRestElement === "boolean";
}

/**
 * Checks if a TypeScript type is a Record type.
 */
export function isRecordType(type: ts.Type): boolean {
    return !!(
        type.aliasSymbol &&
        type.aliasSymbol.escapedName === ("Record" as ts.__String)
    );
}

/**
 * Checks if a TypeScript type has a string index signature.
 */
export function isStringIndexedObjectType(type: ts.Type): ts.Type | undefined {
    return type.getStringIndexType();
}

/**
 * Checks if a TypeScript type has a number index signature.
 */
export function isNumberIndexedType(type: ts.Type): ts.Type | undefined {
    return type.getNumberIndexType();
}

/**
 * Checks if a TypeScript type is an Array type.
 */
export function isArrayType(type: ts.Type): boolean {
    return type.symbol && type.symbol.escapedName === ("Array" as ts.__String);
}

/**
 * Checks if a TypeScript type is a function type.
 */
export function isFunctionType(type: ts.Type): boolean {
    return !!type.getCallSignatures().length;
}

/**
 * Checks if a TypeScript type is a basic object type.
 */
export function isBasicObjectType(
    type: ts.Type,
    checker: ts.TypeChecker,
): boolean {
    return checker.typeToString(type) === "object";
}

/**
 * Checks if a TypeScript type is a literal type (string, number, or boolean literal).
 */
export function isLiteralType(type: ts.Type): boolean {
    return extractFlags(type.flags).some((f) =>
        [
            ts.TypeFlags.StringLiteral,
            ts.TypeFlags.NumberLiteral,
            ts.TypeFlags.BooleanLiteral,
        ].includes(f),
    );
}

/**
 * Checks if a type alias declaration resolves to a primitive type.
 * Returns the primitive type name if so, otherwise undefined.
 */
export function getPrimitiveAliasType(
    node: ts.TypeAliasDeclaration,
    checker: ts.TypeChecker,
): "string" | "number" | "boolean" | undefined {
    const type = checker.getTypeAtLocation(node);

    if (type.flags & ts.TypeFlags.String) return "string";
    if (type.flags & ts.TypeFlags.Number) return "number";
    if (type.flags & ts.TypeFlags.Boolean) return "boolean";

    return undefined;
}

/**
 * Gets the type reference name from an AST node if it's a type reference.
 */
export function getTypeReferenceName(
    typeNode: ts.TypeNode | undefined,
): string | undefined {
    if (!typeNode) return undefined;

    if (ts.isTypeReferenceNode(typeNode)) {
        const typeName = typeNode.typeName;
        if (ts.isIdentifier(typeName)) {
            return typeName.text;
        }
    }

    return undefined;
}
