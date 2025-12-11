/* eslint-disable @typescript-eslint/no-use-before-define,@typescript-eslint/no-unnecessary-condition */
import * as ts from "typescript";

import {
    DEFAULT_FILE_NAME,
    TsToIoConfig,
    defaultConfig,
    displayHelp,
    getCliConfig,
} from "./config.js";
import { extractFlags } from "./flags.js";
import {
    getPrimitiveAliasType,
    getTypeReferenceName,
    isAnyOrUnknown,
    isArrayType,
    isBasicObjectType,
    isFunctionType,
    isLiteralType,
    isNumberIndexedType,
    isObjectType,
    isPrimitiveType,
    isRecordType,
    isStringIndexedObjectType,
    isTupleType,
    isVoid,
    parseNumberedTypeName,
} from "./type.js";

/**
 * Information about a type alias that should become a newtype.
 */
interface NewtypeInfo {
    name: string; // e.g., "Latitude"
    interfaceName: string; // e.g., "Latitude" (same as name, uses declaration merging)
    primitiveType: "string" | "number" | "boolean";
}

/**
 * Information about type aliases that should be deduplicated.
 * Maps numbered variants (e.g., "Foo1", "Foo2") to their base name (e.g., "Foo").
 */
interface DeduplicationInfo {
    /** Map from numbered name to base name (e.g., "NominalsResourceUrl1" -> "NominalsResourceUrl") */
    variantToBase: Map<string, string>;
    /** Set of base names that have variants to deduplicate */
    baseNamesWithVariants: Set<string>;
}

/**
 * Analyzes newtype aliases to find numbered variants that can be deduplicated.
 * Only deduplicates when:
 * 1. The base type (without number suffix) exists
 * 2. All variants resolve to the same primitive type as the base
 */
function analyzeForDeduplication(
    newtypeAliases: Map<string, NewtypeInfo>,
): DeduplicationInfo {
    const variantToBase = new Map<string, string>();
    const baseNamesWithVariants = new Set<string>();

    // Group potential variants by base name
    const potentialGroups = new Map<
        string,
        Array<{ name: string; primitiveType: string }>
    >();

    for (const [name, info] of newtypeAliases) {
        const parsed = parseNumberedTypeName(name);
        if (parsed) {
            // This is a potential numbered variant
            const group = potentialGroups.get(parsed.baseName) || [];
            group.push({ name, primitiveType: info.primitiveType });
            potentialGroups.set(parsed.baseName, group);
        }
    }

    // Check each potential group
    for (const [baseName, variants] of potentialGroups) {
        // Check if base name exists as a newtype
        const baseInfo = newtypeAliases.get(baseName);
        if (!baseInfo) {
            continue; // No base type, don't deduplicate
        }

        // Check all variants have the same primitive type as base
        const allSameType = variants.every(
            (v) => v.primitiveType === baseInfo.primitiveType,
        );
        if (!allSameType) {
            continue; // Different types, don't deduplicate
        }

        // This group is safe to deduplicate
        baseNamesWithVariants.add(baseName);
        for (const variant of variants) {
            variantToBase.set(variant.name, baseName);
        }
    }

    return { variantToBase, baseNamesWithVariants };
}

/**
 * Generates optimized io-ts codec for string literal unions using keyof.
 */
const getOptimizedStringLiteralUnion = (type: ts.UnionType): string => {
    const unionTypes = type.types as ts.StringLiteralType[];
    return `t.keyof({${unionTypes.map((t: ts.StringLiteralType) => `"${t.value}": null`).join(", ")}})`;
};

/**
 * Generates newtype definition code for a primitive type alias.
 */
function generateNewtypeDefinition(info: NewtypeInfo): string {
    const { name, interfaceName, primitiveType } = info;
    const iotsType =
        primitiveType === "boolean" ? "t.boolean" : `t.${primitiveType}`;

    return `export interface ${interfaceName} extends Newtype<{ readonly ${interfaceName}: unique symbol }, ${primitiveType}> {}
export const ${name} = fromNewtype<${interfaceName}>(${iotsType})
export const iso${name} = iso<${interfaceName}>()`;
}

// Forward declare functions to allow mutual recursion
/**
 * Processes a TypeScript object type and generates the corresponding io-ts codec.
 * Handles required and optional properties by creating intersections or partials as needed.
 */
function processObjectType(
    checker: ts.TypeChecker,
    processedDeclarations: Set<string>,
    availableSymbols: Set<string>,
    newtypeAliases: Map<string, NewtypeInfo>,
    deduplicationInfo: DeduplicationInfo | null,
) {
    return (type: ts.ObjectType): string => {
        const properties = checker.getPropertiesOfType(type);
        const requiredProperties = properties.filter(
            (p) =>
                !(p.valueDeclaration as ts.ParameterDeclaration).questionToken,
        );
        const optionalProperties = properties.filter(
            (p) =>
                (p.valueDeclaration as ts.ParameterDeclaration).questionToken,
        );
        if (requiredProperties.length && optionalProperties.length) {
            return `t.intersection([t.type({${requiredProperties
                .map(
                    processProperty(
                        checker,
                        processedDeclarations,
                        availableSymbols,
                        newtypeAliases,
                        deduplicationInfo,
                    ),
                )
                .join(
                    ", ",
                )}}), t.partial({${optionalProperties.map(processProperty(checker, processedDeclarations, availableSymbols, newtypeAliases, deduplicationInfo)).join(", ")}})])`;
        } else if (optionalProperties.length === 0) {
            return `t.type({${requiredProperties.map(processProperty(checker, processedDeclarations, availableSymbols, newtypeAliases, deduplicationInfo)).join(", ")}})`;
        } else {
            return `t.partial({${optionalProperties.map(processProperty(checker, processedDeclarations, availableSymbols, newtypeAliases, deduplicationInfo)).join(", ")}})`;
        }
    };
}

/**
 * Processes a TypeScript property symbol and generates the corresponding io-ts property definition.
 * Preserves type references to known type aliases including newtypes.
 */
function processProperty(
    checker: ts.TypeChecker,
    processedDeclarations: Set<string>,
    availableSymbols: Set<string>,
    newtypeAliases: Map<string, NewtypeInfo>,
    deduplicationInfo: DeduplicationInfo | null,
) {
    return (s: ts.Symbol): string => {
        const type = checker.getTypeOfSymbolAtLocation(s, s.valueDeclaration!);

        // Check if the property's type node references a known type alias
        const valueDecl = s.valueDeclaration as ts.PropertySignature;
        const typeNode = valueDecl?.type;

        // Simple type reference (e.g., `lat: Latitude`)
        let refName = getTypeReferenceName(typeNode);
        // Apply deduplication mapping
        if (refName && deduplicationInfo?.variantToBase.has(refName)) {
            refName = deduplicationInfo.variantToBase.get(refName)!;
        }
        if (refName && availableSymbols.has(refName)) {
            return `${s.name}: ${refName}`;
        }

        // Union type with type references (e.g., `lat: Latitude | null`)
        // Process each AST union member to preserve type reference names
        if (type.isUnion() && typeNode && ts.isUnionTypeNode(typeNode)) {
            const unionCodecs = typeNode.types.map((memberNode) => {
                let memberRefName = getTypeReferenceName(memberNode);
                // Apply deduplication mapping
                if (
                    memberRefName &&
                    deduplicationInfo?.variantToBase.has(memberRefName)
                ) {
                    memberRefName =
                        deduplicationInfo.variantToBase.get(memberRefName)!;
                }
                if (memberRefName && availableSymbols.has(memberRefName)) {
                    return memberRefName;
                }
                // Get the type from the AST node instead of using index
                const memberType = checker.getTypeAtLocation(memberNode);
                return processType(
                    checker,
                    processedDeclarations,
                    availableSymbols,
                    newtypeAliases,
                    deduplicationInfo,
                )(memberType);
            });
            return `${s.name}: t.union([${unionCodecs.join(", ")}])`;
        }

        // Fall back to normal type processing
        return `${s.name}: ${processType(checker, processedDeclarations, availableSymbols, newtypeAliases, deduplicationInfo)(type)}`;
    };
}

/**
 * Processes a TypeScript type and generates the corresponding io-ts codec string.
 * Handles various type kinds including primitives, unions, intersections, arrays, and objects.
 */
function processType(
    checker: ts.TypeChecker,
    processedDeclarations: Set<string>,
    availableSymbols: Set<string>,
    newtypeAliases: Map<string, NewtypeInfo>,
    deduplicationInfo: DeduplicationInfo | null,
) {
    return (type: ts.Type): string => {
        // Check if this is a reference to an available type alias or interface first
        let symbolName = type.symbol?.name || type.aliasSymbol?.name;

        // Apply deduplication mapping
        if (symbolName && deduplicationInfo?.variantToBase.has(symbolName)) {
            symbolName = deduplicationInfo.variantToBase.get(symbolName)!;
        }

        if (symbolName && availableSymbols.has(symbolName)) {
            return symbolName;
        }

        if (isLiteralType(type)) {
            return "t.literal(" + checker.typeToString(type) + ")";
        } else if (isPrimitiveType(type)) {
            return "t." + checker.typeToString(type);
        } else if (isBasicObjectType(type, checker)) {
            return `t.type({})`;
        } else if (type.isUnion()) {
            const isStringLiteralUnion = type.types.every((t) =>
                t.isStringLiteral(),
            );
            if (isStringLiteralUnion) {
                return getOptimizedStringLiteralUnion(type);
            }
            return `t.union([${type.types.map(processType(checker, processedDeclarations, availableSymbols, newtypeAliases, deduplicationInfo)).join(", ")}])`;
        } else if (type.isIntersection()) {
            return `t.intersection([${type.types.map(processType(checker, processedDeclarations, availableSymbols, newtypeAliases, deduplicationInfo)).join(", ")}])`;
        } else if (isTupleType(type)) {
            if (type.hasRestElement) {
                console.warn(
                    "io-ts default validators do not support rest parameters in a tuple",
                );
            }
            return `t.tuple([${type.typeArguments?.map(processType(checker, processedDeclarations, availableSymbols, newtypeAliases, deduplicationInfo)).join(",")}])`;
        } else if (isArrayType(type)) {
            return `t.array(${processType(checker, processedDeclarations, availableSymbols, newtypeAliases, deduplicationInfo)(type.getNumberIndexType()!)})`;
        } else if (isRecordType(type)) {
            const [key, value] = type.aliasTypeArguments!;
            return `t.record(${processType(checker, processedDeclarations, availableSymbols, newtypeAliases, deduplicationInfo)(key)}, ${processType(
                checker,
                processedDeclarations,
                availableSymbols,
                newtypeAliases,
                deduplicationInfo,
            )(value)})`;
        } else if (isStringIndexedObjectType(type)) {
            return `t.record(t.string, ${processType(checker, processedDeclarations, availableSymbols, newtypeAliases, deduplicationInfo)(type.getStringIndexType()!)})`;
        } else if (isNumberIndexedType(type)) {
            return `t.record(t.number, ${processType(checker, processedDeclarations, availableSymbols, newtypeAliases, deduplicationInfo)(type.getNumberIndexType()!)})`;
        } else if (isFunctionType(type)) {
            return `t.Function`;
        } else if (isObjectType(type)) {
            return processObjectType(
                checker,
                processedDeclarations,
                availableSymbols,
                newtypeAliases,
                deduplicationInfo,
            )(type);
        } else if (isVoid(type)) {
            return "t.void";
        } else if (isAnyOrUnknown(type)) {
            return "t.unknown";
        }
        throw Error(
            "Unknown type with type flags: " + String(extractFlags(type.flags)),
        );
    };
}

/**
 * Handles a TypeScript declaration node and generates the corresponding io-ts codec declaration.
 * Supports type aliases, interfaces, and variable statements.
 */
function handleDeclaration(
    node:
        | ts.TypeAliasDeclaration
        | ts.InterfaceDeclaration
        | ts.VariableStatement,
    checker: ts.TypeChecker,
    processedDeclarations: Set<string>,
    availableSymbols: Set<string>,
    newtypeAliases: Map<string, NewtypeInfo>,
    deduplicationInfo: DeduplicationInfo | null,
): string {
    let symbol: ts.Symbol | undefined;
    let type: ts.Type;
    try {
        if (node.kind === ts.SyntaxKind.VariableStatement) {
            symbol = checker.getSymbolAtLocation(
                node.declarationList.declarations[0].name,
            );
            type = checker.getTypeOfSymbolAtLocation(
                symbol!,
                symbol!.valueDeclaration!,
            );
        } else {
            symbol = checker.getSymbolAtLocation(node.name);
            type = checker.getTypeAtLocation(node);
        }

        // Skip deduplicated variants - they will use the base type
        if (symbol?.name && deduplicationInfo?.variantToBase.has(symbol.name)) {
            processedDeclarations.add(symbol.name);
            return ""; // Return empty string for deduplicated variants
        }

        // Check if this is a newtype alias
        if (ts.isTypeAliasDeclaration(node) && symbol?.name) {
            const newtypeInfo = newtypeAliases.get(symbol.name);
            if (newtypeInfo) {
                processedDeclarations.add(symbol.name);
                return generateNewtypeDefinition(newtypeInfo);
            }
        }

        // Create a set of available symbols excluding the current one
        const availableSymbolsForRef = new Set(availableSymbols);
        if (symbol?.name) {
            availableSymbolsForRef.delete(symbol.name);
        }

        // Process the type first
        const processedType = processType(
            checker,
            processedDeclarations,
            availableSymbolsForRef,
            newtypeAliases,
            deduplicationInfo,
        )(type);

        // Add the symbol name to the processed declarations after processing
        if (symbol?.name) {
            processedDeclarations.add(symbol.name);
        }

        return `const ${symbol?.name} = ` + processedType;
    } catch {
        return `// Error: Failed to generate a codec for ${symbol ? symbol.name : ""}`;
    }
}

// Collect type references from a node
/**
 * Recursively collects type references from a TypeScript AST node.
 * Used to build dependency graphs for proper ordering of type declarations.
 */
const collectTypeReferences = (
    node: ts.Node,
    dependencies: Set<string>,
): void => {
    if (ts.isTypeReferenceNode(node)) {
        if (ts.isIdentifier(node.typeName)) {
            dependencies.add(node.typeName.text);
        }
    }

    ts.forEachChild(node, (child) =>
        collectTypeReferences(child, dependencies),
    );
};

/**
 * Collects type declarations from TypeScript AST nodes based on configuration.
 * Filters declarations based on import following settings.
 */
const collectDeclarations =
    (
        config: TsToIoConfig,
        declarations: Array<
            | ts.TypeAliasDeclaration
            | ts.InterfaceDeclaration
            | ts.VariableStatement
        >,
    ) =>
    (node: ts.Node): void => {
        if (
            !config.followImports &&
            !config.fileNames.includes(node.getSourceFile().fileName)
        ) {
            return;
        }
        if (
            ts.isTypeAliasDeclaration(node) ||
            ts.isVariableStatement(node) ||
            ts.isInterfaceDeclaration(node)
        ) {
            declarations.push(node);
        } else if (ts.isModuleDeclaration(node)) {
            ts.forEachChild(node, collectDeclarations(config, declarations));
        }
    };

// Topological sort for dependency ordering
/**
 * Performs topological sort on type declarations to ensure proper dependency ordering.
 * Uses Kahn's algorithm to handle circular dependencies gracefully.
 */
const topologicalSort = (
    declarations: Array<
        ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.VariableStatement
    >,
    checker: ts.TypeChecker,
    availableSymbols: Set<string>,
): Array<
    ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.VariableStatement
> => {
    const graph = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();
    const nodeMap = new Map<
        string,
        ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.VariableStatement
    >();

    // Build dependency graph
    declarations.forEach((node) => {
        let symbol: ts.Symbol | undefined;
        let symbolName: string;

        if (node.kind === ts.SyntaxKind.VariableStatement) {
            symbol = checker.getSymbolAtLocation(
                node.declarationList.declarations[0].name,
            );
            symbolName = symbol?.name || "";
        } else {
            symbol = checker.getSymbolAtLocation(node.name);
            symbolName = symbol?.name || "";
        }

        if (!symbolName) return;

        nodeMap.set(symbolName, node);
        if (!graph.has(symbolName)) {
            graph.set(symbolName, new Set());
        }
        inDegree.set(symbolName, 0);

        // Collect dependencies from the node syntax
        const dependencies = new Set<string>();
        collectTypeReferences(node, dependencies);
        dependencies.delete(symbolName); // Remove self-reference

        // Only consider dependencies that are in our available symbols
        const filteredDeps = new Set<string>();
        dependencies.forEach((dep) => {
            if (availableSymbols.has(dep)) {
                filteredDeps.add(dep);
            }
        });

        // Reverse the dependency direction: if A depends on B, then B -> A
        filteredDeps.forEach((dep) => {
            if (!graph.has(dep)) {
                graph.set(dep, new Set());
            }
            graph.get(dep)!.add(symbolName);
        });
    });

    // Calculate in-degrees
    graph.forEach((deps) => {
        deps.forEach((dep) => {
            if (inDegree.has(dep)) {
                inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
            }
        });
    });

    // Topological sort using Kahn's algorithm
    const queue: string[] = [];
    const result: Array<
        ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.VariableStatement
    > = [];

    // Find nodes with no incoming edges
    inDegree.forEach((degree, node) => {
        if (degree === 0) {
            queue.push(node);
        }
    });

    while (queue.length > 0) {
        const node = queue.shift()!;
        const nodeDeclaration = nodeMap.get(node);
        if (nodeDeclaration) {
            result.push(nodeDeclaration);
        }

        // Reduce in-degree for dependent nodes
        const deps = graph.get(node) || new Set();
        deps.forEach((dep) => {
            const newDegree = (inDegree.get(dep) || 0) - 1;
            inDegree.set(dep, newDegree);
            if (newDegree === 0) {
                queue.push(dep);
            }
        });
    }

    // If there are remaining nodes, there might be circular dependencies
    // For now, just add them at the end
    declarations.forEach((node) => {
        if (!result.includes(node)) {
            result.push(node);
        }
    });

    return result;
};

/**
 * Generates the io-ts import statement for the generated codec file.
 * Includes newtype-ts imports when newtypes are used.
 */
const getImports = (newtypeAliases: Map<string, NewtypeInfo>): string => {
    const imports = ['import * as t from "io-ts"'];

    if (newtypeAliases.size > 0) {
        imports.push(
            'import { fromNewtype } from "io-ts-types/lib/fromNewtype"',
        );
        imports.push('import { Newtype, iso } from "newtype-ts"');
    }

    return imports.join("\n");
};

const compilerOptions: ts.CompilerOptions = {
    strictNullChecks: true,
};

/**
 * Generates io-ts validators from a TypeScript source string.
 * Parses the source, analyzes types, and outputs corresponding io-ts codecs.
 */
export function getValidatorsFromString(
    source: string,
    config: Partial<TsToIoConfig> = {},
): string {
    // Merge with defaults and ensure DEFAULT_FILE_NAME is always included for string processing
    const effectiveConfig: TsToIoConfig = {
        ...defaultConfig,
        ...config,
        fileNames: [DEFAULT_FILE_NAME],
    };
    const defaultCompilerHostOptions = ts.createCompilerHost({});

    const compilerHostOptions = {
        ...defaultCompilerHostOptions,
        getSourceFile: (
            filename: string,
            languageVersion: ts.ScriptTarget,
            ...restArgs: unknown[]
        ) => {
            if (filename === DEFAULT_FILE_NAME)
                return ts.createSourceFile(
                    filename,
                    source,
                    ts.ScriptTarget.ES2015,
                    true,
                );
            else
                return defaultCompilerHostOptions.getSourceFile(
                    filename,
                    languageVersion,
                    ...(restArgs as [
                        onError?: (message: string) => void,
                        shouldCreateNewSourceFile?: boolean | undefined,
                    ]),
                );
        },
    };

    const program = ts.createProgram(
        [DEFAULT_FILE_NAME],
        compilerOptions,
        compilerHostOptions,
    );
    const checker = program.getTypeChecker();

    // Collect all declarations
    const declarations: Array<
        ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.VariableStatement
    > = [];
    ts.forEachChild(
        program.getSourceFile(DEFAULT_FILE_NAME)!,
        collectDeclarations(effectiveConfig, declarations),
    );

    // Create a set of available symbols and track newtype aliases
    const availableSymbols = new Set<string>();
    const newtypeAliases = new Map<string, NewtypeInfo>();
    declarations.forEach((node) => {
        let symbol: ts.Symbol | undefined;
        if (node.kind === ts.SyntaxKind.VariableStatement) {
            symbol = checker.getSymbolAtLocation(
                node.declarationList.declarations[0].name,
            );
        } else {
            symbol = checker.getSymbolAtLocation(node.name);
        }
        if (symbol?.name) {
            availableSymbols.add(symbol.name);

            // Identify primitive type aliases that should become newtypes
            if (
                effectiveConfig.newtypeMode === "all" &&
                ts.isTypeAliasDeclaration(node)
            ) {
                const primitiveType = getPrimitiveAliasType(node, checker);
                if (primitiveType) {
                    newtypeAliases.set(symbol.name, {
                        name: symbol.name,
                        interfaceName: symbol.name,
                        primitiveType,
                    });
                }
            }
        }
    });

    // Apply deduplication if enabled
    let deduplicationInfo: DeduplicationInfo | null = null;
    if (
        effectiveConfig.deduplicateNewtypes &&
        effectiveConfig.newtypeMode === "all"
    ) {
        deduplicationInfo = analyzeForDeduplication(newtypeAliases);

        // Remove numbered variants from newtypeAliases - they will use base type
        for (const variantName of deduplicationInfo.variantToBase.keys()) {
            newtypeAliases.delete(variantName);
        }
    }

    const result = effectiveConfig.includeHeader
        ? [getImports(newtypeAliases)]
        : [];

    // Sort declarations in dependency order
    const sortedDeclarations = topologicalSort(
        declarations,
        checker,
        availableSymbols,
    );

    // Process declarations in dependency order
    const processedDeclarations = new Set<string>();
    sortedDeclarations.forEach((node) => {
        const output = handleDeclaration(
            node,
            checker,
            processedDeclarations,
            availableSymbols,
            newtypeAliases,
            deduplicationInfo,
        );
        // Filter out empty strings from deduplicated variants
        if (output) {
            result.push(output);
        }
    });

    return result.join("\n\n");
}

/**
 * Generates io-ts validators from TypeScript files specified in CLI arguments.
 * Reads configuration from command line and processes the specified files.
 */
export function getValidatorsFromFileNames(): string {
    const config = getCliConfig();
    if (!config.fileNames.length) {
        return displayHelp();
    }
    const program = ts.createProgram(config.fileNames, compilerOptions);
    const checker = program.getTypeChecker();

    // Collect all declarations
    const declarations: Array<
        ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.VariableStatement
    > = [];
    for (const sourceFile of program.getSourceFiles()) {
        if (!sourceFile.isDeclarationFile) {
            ts.forEachChild(
                sourceFile,
                collectDeclarations(config, declarations),
            );
        }
    }

    // Create a set of available symbols and track newtype aliases
    const availableSymbols = new Set<string>();
    const newtypeAliases = new Map<string, NewtypeInfo>();
    declarations.forEach((node) => {
        let symbol: ts.Symbol | undefined;
        if (node.kind === ts.SyntaxKind.VariableStatement) {
            symbol = checker.getSymbolAtLocation(
                node.declarationList.declarations[0].name,
            );
        } else {
            symbol = checker.getSymbolAtLocation(node.name);
        }
        if (symbol?.name) {
            availableSymbols.add(symbol.name);

            // Identify primitive type aliases that should become newtypes
            if (
                config.newtypeMode === "all" &&
                ts.isTypeAliasDeclaration(node)
            ) {
                const primitiveType = getPrimitiveAliasType(node, checker);
                if (primitiveType) {
                    newtypeAliases.set(symbol.name, {
                        name: symbol.name,
                        interfaceName: symbol.name,
                        primitiveType,
                    });
                }
            }
        }
    });

    // Apply deduplication if enabled
    let deduplicationInfo: DeduplicationInfo | null = null;
    if (config.deduplicateNewtypes && config.newtypeMode === "all") {
        deduplicationInfo = analyzeForDeduplication(newtypeAliases);

        // Remove numbered variants from newtypeAliases - they will use base type
        for (const variantName of deduplicationInfo.variantToBase.keys()) {
            newtypeAliases.delete(variantName);
        }
    }

    const result = config.includeHeader ? [getImports(newtypeAliases)] : [];

    // Sort declarations in dependency order
    const sortedDeclarations = topologicalSort(
        declarations,
        checker,
        availableSymbols,
    );

    // Process declarations in dependency order
    const processedDeclarations = new Set<string>();
    sortedDeclarations.forEach((node) => {
        const output = handleDeclaration(
            node,
            checker,
            processedDeclarations,
            availableSymbols,
            newtypeAliases,
            deduplicationInfo,
        );
        // Filter out empty strings from deduplicated variants
        if (output) {
            result.push(output);
        }
    });

    return result.join("\n\n");
}

export { defaultConfig, TsToIoConfig };
