import ts from 'typescript-legacy';
import path from 'path';

// Define the path to your specific TypeScript file you want to analyze
const targetFilePath = './packages/ts-type-math/divide-playground.ts';

// Read the tsconfig.json file
const configPath = ts.findConfigFile(
    './', // Current directory
    ts.sys.fileExists,
    'tsconfig.json'
);

if (!configPath) {
    throw new Error("Could not find a valid 'tsconfig.json'.");
}

// Parse the tsconfig.json content
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
const parsedCommandLine = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath)
);

parsedCommandLine.fileNames = [targetFilePath];

// Create a program instance with the parsed configuration
const program = ts.createProgram(parsedCommandLine.fileNames, parsedCommandLine.options);

// Get the type checker, which you'll use to examine  ftypes
const checker = program.getTypeChecker();

// For each source file in the program
for (const sourceFile of program.getSourceFiles()) {
    // Skip declaration files
    if (!sourceFile.isDeclarationFile) {
        // Visit each node in the source file
        ts.forEachChild(sourceFile, visit);
    }
}

function visit(node: ts.Node) {
    // Only work with variable statements for this example
    if (ts.isTypeAliasDeclaration(node)) {
        switch (node.name.text) {
            case 'x_64': { 
                console.log(`Inspecting TypeAlias '${node.name.text}':`);
                performance.mark('getTypeAtLocation1');
                const type = checker.getTypeAtLocation(node);

                const typeString = checker.typeToString(type);

                performance.mark('getTypeAtLocation2');
                console.dir({
                    getTypeAtLocation: performance.measure('', 'getTypeAtLocation1', 'getTypeAtLocation2').duration,
                    typeString: typeString.replaceAll('\\n', '\n'),
                });
                break;
            }
        }
    }

    // Continue traversing the tree
    ts.forEachChild(node, visit);
}

console.log('Done');
