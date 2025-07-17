import { Command } from "commander";

const VERSION = "0.4.0";

/**
 * Creates and configures the Commander.js program for the ts-to-io CLI.
 * Sets up command line options and arguments for the tool.
 */
function createProgram(): Command {
    const program = new Command();
    program
        .name("ts-to-io")
        .version(VERSION)
        .option(
            "--follow-imports",
            "output codecs for types declared in imported files",
        )
        .option("--no-include-header", "omit io-ts import from the output")
        .arguments("<files>");
    return program;
}

/**
 * Parses command line arguments and returns the configuration object.
 * Combines CLI options with file arguments into a unified config structure.
 */
export function getCliConfig(): TsToIoConfig {
    const program = createProgram();
    program.parse(process.argv);

    return {
        ...program.opts(),
        fileNames: program.args,
    } as TsToIoConfig;
}

/**
 * Displays help information for the CLI tool.
 * Shows usage instructions and available options.
 */
export function displayHelp(): string {
    const program = createProgram();
    return program.help();
}

export const DEFAULT_FILE_NAME = "io-to-ts.ts";

export interface TsToIoConfig {
    followImports: boolean;
    includeHeader: boolean;
    fileNames: string[];
}

export const defaultConfig: TsToIoConfig = {
    followImports: false,
    includeHeader: true,
    fileNames: [],
};
