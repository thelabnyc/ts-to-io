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
} from "./type.js";

/**
 * Generates optimized io-ts codec for string literal unions using keyof.
 */
const getOptimizedStringLiteralUnion = (type: ts.UnionType): string => {
    const unionTypes = type.types as ts.StringLiteralType[];
    return `t.keyof({${unionTypes.map((t: ts.StringLiteralType) => `"${t.value}": null`).join(", ")}})`;
};

// Forward declare functions to allow mutual recursion
/**
 * Processes a TypeScript object type and generates the corresponding io-ts codec.
 * Handles required and optional properties by creating intersections or partials as needed.
 */
function processObjectType(
    checker: ts.TypeChecker,
    processedDeclarations: Set<string>,
    availableSymbols: Set<string>,
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
                    ),
                )
                .join(
                    ", ",
                )}}), t.partial({${optionalProperties.map(processProperty(checker, processedDeclarations, availableSymbols)).join(", ")}})])`;
        } else if (optionalProperties.length === 0) {
            return `t.type({${requiredProperties.map(processProperty(checker, processedDeclarations, availableSymbols)).join(", ")}})`;
        } else {
            return `t.partial({${optionalProperties.map(processProperty(checker, processedDeclarations, availableSymbols)).join(", ")}})`;
        }
    };
}

/**
 * Processes a TypeScript property symbol and generates the corresponding io-ts property definition.
 */
function processProperty(
    checker: ts.TypeChecker,
    processedDeclarations: Set<string>,
    availableSymbols: Set<string>,
) {
    return (s: ts.Symbol): string => {
        return `${s.name}: ${processType(checker, processedDeclarations, availableSymbols)(checker.getTypeOfSymbolAtLocation(s, s.valueDeclaration!))}`;
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
) {
    return (type: ts.Type): string => {
        // Check if this is a reference to an available type alias or interface first
        if (
            type.symbol &&
            type.symbol.name &&
            availableSymbols.has(type.symbol.name)
        ) {
            return type.symbol.name;
        }

        // Check if this is a type alias by looking at the aliasSymbol
        if (
            type.aliasSymbol &&
            type.aliasSymbol.name &&
            availableSymbols.has(type.aliasSymbol.name)
        ) {
            return type.aliasSymbol.name;
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
            return `t.union([${type.types.map(processType(checker, processedDeclarations, availableSymbols)).join(", ")}])`;
        } else if (type.isIntersection()) {
            return `t.intersection([${type.types.map(processType(checker, processedDeclarations, availableSymbols)).join(", ")}])`;
        } else if (isTupleType(type)) {
            if (type.hasRestElement) {
                console.warn(
                    "io-ts default validators do not support rest parameters in a tuple",
                );
            }
            return `t.tuple([${type.typeArguments?.map(processType(checker, processedDeclarations, availableSymbols)).join(",")}])`;
        } else if (isArrayType(type)) {
            return `t.array(${processType(checker, processedDeclarations, availableSymbols)(type.getNumberIndexType()!)})`;
        } else if (isRecordType(type)) {
            const [key, value] = type.aliasTypeArguments!;
            return `t.record(${processType(checker, processedDeclarations, availableSymbols)(key)}, ${processType(
                checker,
                processedDeclarations,
                availableSymbols,
            )(value)})`;
        } else if (isStringIndexedObjectType(type)) {
            return `t.record(t.string, ${processType(checker, processedDeclarations, availableSymbols)(type.getStringIndexType()!)})`;
        } else if (isNumberIndexedType(type)) {
            return `t.record(t.number, ${processType(checker, processedDeclarations, availableSymbols)(type.getNumberIndexType()!)})`;
        } else if (isFunctionType(type)) {
            return `t.Function`;
        } else if (isObjectType(type)) {
            return processObjectType(
                checker,
                processedDeclarations,
                availableSymbols,
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
 */
const getImports = (): string => {
    return `import * as t from "io-ts"`;
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
    config = { ...defaultConfig, fileNames: [DEFAULT_FILE_NAME] },
): string {
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
                        onError?: (message: string) => void | undefined,
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
    const result = config.includeHeader ? [getImports()] : [];

    // Collect all declarations
    const declarations: Array<
        ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.VariableStatement
    > = [];
    ts.forEachChild(
        program.getSourceFile(DEFAULT_FILE_NAME)!,
        collectDeclarations(config, declarations),
    );

    // Create a set of available symbols
    const availableSymbols = new Set<string>();
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
        }
    });

    // Sort declarations in dependency order
    const sortedDeclarations = topologicalSort(
        declarations,
        checker,
        availableSymbols,
    );

    // Process declarations in dependency order
    const processedDeclarations = new Set<string>();
    sortedDeclarations.forEach((node) => {
        result.push(
            handleDeclaration(
                node,
                checker,
                processedDeclarations,
                availableSymbols,
            ),
        );
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
    const result = config.includeHeader ? [getImports()] : [];

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

    // Create a set of available symbols
    const availableSymbols = new Set<string>();
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
        }
    });

    // Sort declarations in dependency order
    const sortedDeclarations = topologicalSort(
        declarations,
        checker,
        availableSymbols,
    );

    // Process declarations in dependency order
    const processedDeclarations = new Set<string>();
    sortedDeclarations.forEach((node) => {
        result.push(
            handleDeclaration(
                node,
                checker,
                processedDeclarations,
                availableSymbols,
            ),
        );
    });

    return result.join("\n\n");
}
