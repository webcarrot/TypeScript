namespace ts {
    const infoExtension = ".tsbundleinfo";
    const brackets = createBracketsMap();
    const syntheticParent: TextRange = { pos: -1, end: -1 };

    /*@internal*/
    /**
     * Iterates over the source files that are expected to have an emit output.
     *
     * @param host An EmitHost.
     * @param action The action to execute.
     * @param sourceFilesOrTargetSourceFile
     *   If an array, the full list of source files to emit.
     *   Else, calls `getSourceFilesToEmit` with the (optional) target source file to determine the list of source files to emit.
     */
    export function forEachEmittedFile<T>(
        host: EmitHost, action: (emitFileNames: EmitFileNames, sourceFileOrBundle: SourceFile | Bundle) => T,
        sourceFilesOrTargetSourceFile?: ReadonlyArray<SourceFile> | SourceFile,
        emitOnlyDtsFiles = false) {
        const sourceFiles = isArray(sourceFilesOrTargetSourceFile) ? sourceFilesOrTargetSourceFile : getSourceFilesToEmit(host, sourceFilesOrTargetSourceFile);
        const options = host.getCompilerOptions();
        if (options.outFile || options.out) {
            if (sourceFiles.length) {
                const bundle = createBundle(sourceFiles, host.getPrependNodes());
                const result = action(getOutputPathsFor(bundle, host, emitOnlyDtsFiles), bundle);
                if (result) {
                    return result;
                }
            }
        }
        else {
            for (const sourceFile of sourceFiles) {
                const result = action(getOutputPathsFor(sourceFile, host, emitOnlyDtsFiles), sourceFile);
                if (result) {
                    return result;
                }
            }
        }
    }

    /*@internal*/
    export function getOutputPathsFor(sourceFile: SourceFile | Bundle, host: EmitHost, forceDtsPaths: boolean): EmitFileNames {
        const options = host.getCompilerOptions();
        if (sourceFile.kind === SyntaxKind.Bundle) {
            const outPath = options.outFile || options.out!;
            const jsFilePath = options.emitDeclarationOnly ? undefined : outPath;
            const sourceMapFilePath = jsFilePath && getSourceMapFilePath(jsFilePath, options);
            const declarationFilePath = (forceDtsPaths || getEmitDeclarations(options)) ? removeFileExtension(outPath) + Extension.Dts : undefined;
            const declarationMapPath = declarationFilePath && getAreDeclarationMapsEnabled(options) ? declarationFilePath + ".map" : undefined;
            const bundleInfoPath = options.references && jsFilePath ? (removeFileExtension(jsFilePath) + infoExtension) : undefined;
            return { jsFilePath, sourceMapFilePath, declarationFilePath, declarationMapPath, bundleInfoPath };
        }
        else {
            const ownOutputFilePath = getOwnEmitOutputFilePath(sourceFile.fileName, host, getOutputExtension(sourceFile, options));
            // If json file emits to the same location skip writing it, if emitDeclarationOnly skip writing it
            const isJsonEmittedToSameLocation = isJsonSourceFile(sourceFile) &&
                comparePaths(sourceFile.fileName, ownOutputFilePath, host.getCurrentDirectory(), !host.useCaseSensitiveFileNames()) === Comparison.EqualTo;
            const jsFilePath = options.emitDeclarationOnly || isJsonEmittedToSameLocation ? undefined : ownOutputFilePath;
            const sourceMapFilePath = !jsFilePath || isJsonSourceFile(sourceFile) ? undefined : getSourceMapFilePath(jsFilePath, options);
            // For legacy reasons (ie, we have baselines capturing the behavior), js files don't report a .d.ts output path - this would only matter if `declaration` and `allowJs` were both on, which is currently an error
            const isJs = isSourceFileJS(sourceFile);
            const declarationFilePath = ((forceDtsPaths || getEmitDeclarations(options)) && !isJs) ? getDeclarationEmitOutputFilePath(sourceFile.fileName, host) : undefined;
            const declarationMapPath = declarationFilePath && getAreDeclarationMapsEnabled(options) ? declarationFilePath + ".map" : undefined;
            return { jsFilePath, sourceMapFilePath, declarationFilePath, declarationMapPath, bundleInfoPath: undefined };
        }
    }

    function getSourceMapFilePath(jsFilePath: string, options: CompilerOptions) {
        return (options.sourceMap && !options.inlineSourceMap) ? jsFilePath + ".map" : undefined;
    }

    function createDefaultBundleInfo(): BundleInfo {
        return {
            originalOffset: -1,
            totalLength: -1
        };
    }

    // JavaScript files are always LanguageVariant.JSX, as JSX syntax is allowed in .js files also.
    // So for JavaScript files, '.jsx' is only emitted if the input was '.jsx', and JsxEmit.Preserve.
    // For TypeScript, the only time to emit with a '.jsx' extension, is on JSX input, and JsxEmit.Preserve
    /* @internal */
    export function getOutputExtension(sourceFile: SourceFile, options: CompilerOptions): Extension {
        if (isJsonSourceFile(sourceFile)) {
            return Extension.Json;
        }

        if (options.jsx === JsxEmit.Preserve) {
            if (isSourceFileJS(sourceFile)) {
                if (fileExtensionIs(sourceFile.fileName, Extension.Jsx)) {
                    return Extension.Jsx;
                }
            }
            else if (sourceFile.languageVariant === LanguageVariant.JSX) {
                // TypeScript source file preserving JSX syntax
                return Extension.Jsx;
            }
        }
        return Extension.Js;
    }

    /*@internal*/
    // targetSourceFile is when users only want one file in entire project to be emitted. This is used in compileOnSave feature
    export function emitFiles(resolver: EmitResolver, host: EmitHost, targetSourceFile: SourceFile, emitOnlyDtsFiles?: boolean, transformers?: TransformerFactory<Bundle | SourceFile>[], declarationTransformers?: TransformerFactory<Bundle | SourceFile>[]): EmitResult {
        const compilerOptions = host.getCompilerOptions();
        const sourceMapDataList: SourceMapEmitResult[] | undefined = (compilerOptions.sourceMap || compilerOptions.inlineSourceMap || getAreDeclarationMapsEnabled(compilerOptions)) ? [] : undefined;
        const emittedFilesList: string[] | undefined = compilerOptions.listEmittedFiles ? [] : undefined;
        const emitterDiagnostics = createDiagnosticCollection();
        const newLine = getNewLineCharacter(compilerOptions, () => host.getNewLine());
        const writer = createTextWriter(newLine);
        const { enter, exit } = performance.createTimer("printTime", "beforePrint", "afterPrint");
        let bundleInfo: BundleInfo = createDefaultBundleInfo();
        let emitSkipped = false;
        let exportedModulesFromDeclarationEmit: ExportedModulesFromDeclarationEmit | undefined;

        // Emit each output file
        enter();
        forEachEmittedFile(host, emitSourceFileOrBundle, getSourceFilesToEmit(host, targetSourceFile), emitOnlyDtsFiles);
        exit();


        return {
            emitSkipped,
            diagnostics: emitterDiagnostics.getDiagnostics(),
            emittedFiles: emittedFilesList,
            sourceMaps: sourceMapDataList,
            exportedModulesFromDeclarationEmit
        };

        function emitSourceFileOrBundle({ jsFilePath, sourceMapFilePath, declarationFilePath, declarationMapPath, bundleInfoPath }: EmitFileNames, sourceFileOrBundle: SourceFile | Bundle) {
            emitJsFileOrBundle(sourceFileOrBundle, jsFilePath, sourceMapFilePath, bundleInfoPath);
            emitDeclarationFileOrBundle(sourceFileOrBundle, declarationFilePath, declarationMapPath);

            if (!emitSkipped && emittedFilesList) {
                if (!emitOnlyDtsFiles) {
                    if (jsFilePath) {
                        emittedFilesList.push(jsFilePath);
                    }
                    if (sourceMapFilePath) {
                        emittedFilesList.push(sourceMapFilePath);
                    }
                    if (bundleInfoPath) {
                        emittedFilesList.push(bundleInfoPath);
                    }
                }
                if (declarationFilePath) {
                    emittedFilesList.push(declarationFilePath);
                }
                if (declarationMapPath) {
                    emittedFilesList.push(declarationMapPath);
                }
            }
        }

        function emitJsFileOrBundle(sourceFileOrBundle: SourceFile | Bundle, jsFilePath: string | undefined, sourceMapFilePath: string | undefined, bundleInfoPath: string | undefined) {
            if (emitOnlyDtsFiles || !jsFilePath) {
                return;
            }

            // Make sure not to write js file and source map file if any of them cannot be written
            if ((jsFilePath && host.isEmitBlocked(jsFilePath)) || compilerOptions.noEmit) {
                emitSkipped = true;
                return;
            }
            // Transform the source files
            const transform = transformNodes(resolver, host, compilerOptions, [sourceFileOrBundle], transformers!, /*allowDtsFiles*/ false);

            const printerOptions: PrinterOptions = {
                removeComments: compilerOptions.removeComments,
                newLine: compilerOptions.newLine,
                noEmitHelpers: compilerOptions.noEmitHelpers,
                module: compilerOptions.module,
                target: compilerOptions.target,
                sourceMap: compilerOptions.sourceMap,
                inlineSourceMap: compilerOptions.inlineSourceMap,
                inlineSources: compilerOptions.inlineSources,
                extendedDiagnostics: compilerOptions.extendedDiagnostics,
            };

            // Create a printer to print the nodes
            const printer = createPrinter(printerOptions, {
                // resolver hooks
                hasGlobalName: resolver.hasGlobalName,

                // transform hooks
                onEmitNode: transform.emitNodeWithNotification,
                substituteNode: transform.substituteNode,
            });

            Debug.assert(transform.transformed.length === 1, "Should only see one output from the transform");
            printSourceFileOrBundle(jsFilePath, sourceMapFilePath, transform.transformed[0], bundleInfoPath, printer, compilerOptions);

            // Clean up emit nodes on parse tree
            transform.dispose();
        }

        function emitDeclarationFileOrBundle(sourceFileOrBundle: SourceFile | Bundle, declarationFilePath: string | undefined, declarationMapPath: string | undefined) {
            if (!(declarationFilePath && !isInJSFile(sourceFileOrBundle))) {
                return;
            }
            const sourceFiles = isSourceFile(sourceFileOrBundle) ? [sourceFileOrBundle] : sourceFileOrBundle.sourceFiles;
            // Setup and perform the transformation to retrieve declarations from the input files
            const nonJsFiles = filter(sourceFiles, isSourceFileNotJS);
            const inputListOrBundle = (compilerOptions.outFile || compilerOptions.out) ? [createBundle(nonJsFiles, !isSourceFile(sourceFileOrBundle) ? sourceFileOrBundle.prepends : undefined)] : nonJsFiles;
            if (emitOnlyDtsFiles && !getEmitDeclarations(compilerOptions)) {
                // Checker wont collect the linked aliases since thats only done when declaration is enabled.
                // Do that here when emitting only dts files
                nonJsFiles.forEach(collectLinkedAliases);
            }
            const declarationTransform = transformNodes(resolver, host, compilerOptions, inputListOrBundle, concatenate([transformDeclarations], declarationTransformers), /*allowDtsFiles*/ false);
            if (length(declarationTransform.diagnostics)) {
                for (const diagnostic of declarationTransform.diagnostics!) {
                    emitterDiagnostics.add(diagnostic);
                }
            }

            const printerOptions: PrinterOptions = {
                removeComments: compilerOptions.removeComments,
                newLine: compilerOptions.newLine,
                noEmitHelpers: true,
                module: compilerOptions.module,
                target: compilerOptions.target,
                sourceMap: compilerOptions.sourceMap,
                inlineSourceMap: compilerOptions.inlineSourceMap,
                extendedDiagnostics: compilerOptions.extendedDiagnostics,
                onlyPrintJsDocStyle: true,
            };

            const declarationPrinter = createPrinter(printerOptions, {
                // resolver hooks
                hasGlobalName: resolver.hasGlobalName,

                // transform hooks
                onEmitNode: declarationTransform.emitNodeWithNotification,
                substituteNode: declarationTransform.substituteNode,
            });
            const declBlocked = (!!declarationTransform.diagnostics && !!declarationTransform.diagnostics.length) || !!host.isEmitBlocked(declarationFilePath) || !!compilerOptions.noEmit;
            emitSkipped = emitSkipped || declBlocked;
            if (!declBlocked || emitOnlyDtsFiles) {
                Debug.assert(declarationTransform.transformed.length === 1, "Should only see one output from the decl transform");
                printSourceFileOrBundle(declarationFilePath, declarationMapPath, declarationTransform.transformed[0], /* bundleInfopath*/ undefined, declarationPrinter, {
                    sourceMap: compilerOptions.declarationMap,
                    sourceRoot: compilerOptions.sourceRoot,
                    mapRoot: compilerOptions.mapRoot,
                    extendedDiagnostics: compilerOptions.extendedDiagnostics,
                    // Explicitly do not passthru either `inline` option
                });
                if (emitOnlyDtsFiles && declarationTransform.transformed[0].kind === SyntaxKind.SourceFile) {
                    const sourceFile = declarationTransform.transformed[0] as SourceFile;
                    exportedModulesFromDeclarationEmit = sourceFile.exportedModulesFromDeclarationEmit;
                }
            }
            declarationTransform.dispose();
        }

        function collectLinkedAliases(node: Node) {
            if (isExportAssignment(node)) {
                if (node.expression.kind === SyntaxKind.Identifier) {
                    resolver.collectLinkedAliases(node.expression as Identifier, /*setVisibility*/ true);
                }
                return;
            }
            else if (isExportSpecifier(node)) {
                resolver.collectLinkedAliases(node.propertyName || node.name, /*setVisibility*/ true);
                return;
            }
            forEachChild(node, collectLinkedAliases);
        }

        function printSourceFileOrBundle(jsFilePath: string, sourceMapFilePath: string | undefined, sourceFileOrBundle: SourceFile | Bundle, bundleInfoPath: string | undefined, printer: Printer, mapOptions: SourceMapOptions) {
            const bundle = sourceFileOrBundle.kind === SyntaxKind.Bundle ? sourceFileOrBundle : undefined;
            const sourceFile = sourceFileOrBundle.kind === SyntaxKind.SourceFile ? sourceFileOrBundle : undefined;
            const sourceFiles = bundle ? bundle.sourceFiles : [sourceFile!];

            let sourceMapGenerator: SourceMapGenerator | undefined;
            if (shouldEmitSourceMaps(mapOptions, sourceFileOrBundle)) {
                sourceMapGenerator = createSourceMapGenerator(
                    host,
                    getBaseFileName(normalizeSlashes(jsFilePath)),
                    getSourceRoot(mapOptions),
                    getSourceMapDirectory(mapOptions, jsFilePath, sourceFile),
                    mapOptions);
            }

            if (bundle) {
                printer.writeBundle(bundle, bundleInfo, writer, sourceMapGenerator);
            }
            else {
                printer.writeFile(sourceFile!, writer, sourceMapGenerator);
            }

            if (sourceMapGenerator) {
                if (sourceMapDataList) {
                    sourceMapDataList.push({
                        inputSourceFileNames: sourceMapGenerator.getSources(),
                        sourceMap: sourceMapGenerator.toJSON()
                    });
                }

                const sourceMappingURL = getSourceMappingURL(
                    mapOptions,
                    sourceMapGenerator,
                    jsFilePath,
                    sourceMapFilePath,
                    sourceFile);

                if (sourceMappingURL) {
                    if (!writer.isAtStartOfLine()) writer.rawWrite(newLine);
                    writer.writeComment(`//# ${"sourceMappingURL"}=${sourceMappingURL}`); // Tools can sometimes see this line as a source mapping url comment
                }

                // Write the source map
                if (sourceMapFilePath) {
                    const sourceMap = sourceMapGenerator.toString();
                    writeFile(host, emitterDiagnostics, sourceMapFilePath, sourceMap, /*writeByteOrderMark*/ false, sourceFiles);
                }
            }
            else {
                writer.writeLine();
            }

            // Write the output file
            writeFile(host, emitterDiagnostics, jsFilePath, writer.getText(), !!compilerOptions.emitBOM, sourceFiles);

            // Write bundled offset information if applicable
            if (bundleInfoPath) {
                bundleInfo.totalLength = writer.getTextPos();
                writeFile(host, emitterDiagnostics, bundleInfoPath, JSON.stringify(bundleInfo, undefined, 2), /*writeByteOrderMark*/ false);
            }

            // Reset state
            writer.clear();

            bundleInfo = createDefaultBundleInfo();
        }

        interface SourceMapOptions {
            sourceMap?: boolean;
            inlineSourceMap?: boolean;
            inlineSources?: boolean;
            sourceRoot?: string;
            mapRoot?: string;
            extendedDiagnostics?: boolean;
        }

        function shouldEmitSourceMaps(mapOptions: SourceMapOptions, sourceFileOrBundle: SourceFile | Bundle) {
            return (mapOptions.sourceMap || mapOptions.inlineSourceMap)
                && (sourceFileOrBundle.kind !== SyntaxKind.SourceFile || !fileExtensionIs(sourceFileOrBundle.fileName, Extension.Json));
        }

        function getSourceRoot(mapOptions: SourceMapOptions) {
            // Normalize source root and make sure it has trailing "/" so that it can be used to combine paths with the
            // relative paths of the sources list in the sourcemap
            const sourceRoot = normalizeSlashes(mapOptions.sourceRoot || "");
            return sourceRoot ? ensureTrailingDirectorySeparator(sourceRoot) : sourceRoot;
        }

        function getSourceMapDirectory(mapOptions: SourceMapOptions, filePath: string, sourceFile: SourceFile | undefined) {
            if (mapOptions.sourceRoot) return host.getCommonSourceDirectory();
            if (mapOptions.mapRoot) {
                let sourceMapDir = normalizeSlashes(mapOptions.mapRoot);
                if (sourceFile) {
                    // For modules or multiple emit files the mapRoot will have directory structure like the sources
                    // So if src\a.ts and src\lib\b.ts are compiled together user would be moving the maps into mapRoot\a.js.map and mapRoot\lib\b.js.map
                    sourceMapDir = getDirectoryPath(getSourceFilePathInNewDir(sourceFile.fileName, host, sourceMapDir));
                }
                if (getRootLength(sourceMapDir) === 0) {
                    // The relative paths are relative to the common directory
                    sourceMapDir = combinePaths(host.getCommonSourceDirectory(), sourceMapDir);
                }
                return sourceMapDir;
            }
            return getDirectoryPath(normalizePath(filePath));
        }

        function getSourceMappingURL(mapOptions: SourceMapOptions, sourceMapGenerator: SourceMapGenerator, filePath: string, sourceMapFilePath: string | undefined, sourceFile: SourceFile | undefined) {
            if (mapOptions.inlineSourceMap) {
                // Encode the sourceMap into the sourceMap url
                const sourceMapText = sourceMapGenerator.toString();
                const base64SourceMapText = base64encode(sys, sourceMapText);
                return `data:application/json;base64,${base64SourceMapText}`;
            }

            const sourceMapFile = getBaseFileName(normalizeSlashes(Debug.assertDefined(sourceMapFilePath)));
            if (mapOptions.mapRoot) {
                let sourceMapDir = normalizeSlashes(mapOptions.mapRoot);
                if (sourceFile) {
                    // For modules or multiple emit files the mapRoot will have directory structure like the sources
                    // So if src\a.ts and src\lib\b.ts are compiled together user would be moving the maps into mapRoot\a.js.map and mapRoot\lib\b.js.map
                    sourceMapDir = getDirectoryPath(getSourceFilePathInNewDir(sourceFile.fileName, host, sourceMapDir));
                }
                if (getRootLength(sourceMapDir) === 0) {
                    // The relative paths are relative to the common directory
                    sourceMapDir = combinePaths(host.getCommonSourceDirectory(), sourceMapDir);
                    return getRelativePathToDirectoryOrUrl(
                        getDirectoryPath(normalizePath(filePath)), // get the relative sourceMapDir path based on jsFilePath
                        combinePaths(sourceMapDir, sourceMapFile), // this is where user expects to see sourceMap
                        host.getCurrentDirectory(),
                        host.getCanonicalFileName,
                        /*isAbsolutePathAnUrl*/ true);
                }
                else {
                    return combinePaths(sourceMapDir, sourceMapFile);
                }
            }
            return sourceMapFile;
        }
    }

    const enum PipelinePhase {
        Notification,
        Substitution,
        Comments,
        SourceMaps,
        Emit
    }

    export function createPrinter(printerOptions: PrinterOptions = {}, handlers: PrintHandlers = {}): Printer {
        const {
            hasGlobalName,
            onEmitNode = noEmitNotification,
            substituteNode = noEmitSubstitution,
            onBeforeEmitNodeArray,
            onAfterEmitNodeArray,
            onBeforeEmitToken,
            onAfterEmitToken
        } = handlers;

        const extendedDiagnostics = !!printerOptions.extendedDiagnostics;
        const newLine = getNewLineCharacter(printerOptions);
        const moduleKind = getEmitModuleKind(printerOptions);
        const bundledHelpers = createMap<boolean>();

        let currentSourceFile: SourceFile | undefined;
        let nodeIdToGeneratedName: string[]; // Map of generated names for specific nodes.
        let autoGeneratedIdToGeneratedName: string[]; // Map of generated names for temp and loop variables.
        let generatedNames: Map<true>; // Set of names generated by the NameGenerator.
        let tempFlagsStack: TempFlags[]; // Stack of enclosing name generation scopes.
        let tempFlags: TempFlags; // TempFlags for the current name generation scope.
        let reservedNamesStack: Map<true>[]; // Stack of TempFlags reserved in enclosing name generation scopes.
        let reservedNames: Map<true>; // TempFlags to reserve in nested name generation scopes.

        let writer: EmitTextWriter;
        let ownWriter: EmitTextWriter; // Reusable `EmitTextWriter` for basic printing.
        let write = writeBase;
        let isOwnFileEmit: boolean;

        // Source Maps
        let sourceMapsDisabled = true;
        let sourceMapGenerator: SourceMapGenerator | undefined;
        let sourceMapSource: SourceMapSource;
        let sourceMapSourceIndex = -1;

        // Comments
        let containerPos = -1;
        let containerEnd = -1;
        let declarationListContainerEnd = -1;
        let currentLineMap: ReadonlyArray<number> | undefined;
        let detachedCommentsInfo: { nodePos: number, detachedCommentEndPos: number}[] | undefined;
        let hasWrittenComment = false;
        let commentsDisabled = !!printerOptions.removeComments;
        const { enter: enterComment, exit: exitComment } = performance.createTimerIf(extendedDiagnostics, "commentTime", "beforeComment", "afterComment");

        reset();
        return {
            // public API
            printNode,
            printList,
            printFile,
            printBundle,

            // internal API
            writeNode,
            writeList,
            writeFile,
            writeBundle
        };

        function printNode(hint: EmitHint, node: Node, sourceFile: SourceFile): string {
            switch (hint) {
                case EmitHint.SourceFile:
                    Debug.assert(isSourceFile(node), "Expected a SourceFile node.");
                    break;
                case EmitHint.IdentifierName:
                    Debug.assert(isIdentifier(node), "Expected an Identifier node.");
                    break;
                case EmitHint.Expression:
                    Debug.assert(isExpression(node), "Expected an Expression node.");
                    break;
            }
            switch (node.kind) {
                case SyntaxKind.SourceFile: return printFile(<SourceFile>node);
                case SyntaxKind.Bundle: return printBundle(<Bundle>node);
                case SyntaxKind.UnparsedSource: return printUnparsedSource(<UnparsedSource>node);
            }
            writeNode(hint, node, sourceFile, beginPrint());
            return endPrint();
        }

        function printList<T extends Node>(format: ListFormat, nodes: NodeArray<T>, sourceFile: SourceFile) {
            writeList(format, nodes, sourceFile, beginPrint());
            return endPrint();
        }

        function printBundle(bundle: Bundle): string {
            writeBundle(bundle, /*bundleInfo*/ undefined, beginPrint(), /*sourceMapEmitter*/ undefined);
            return endPrint();
        }

        function printFile(sourceFile: SourceFile): string {
            writeFile(sourceFile, beginPrint(), /*sourceMapEmitter*/ undefined);
            return endPrint();
        }

        function printUnparsedSource(unparsed: UnparsedSource): string {
            writeUnparsedSource(unparsed, beginPrint());
            return endPrint();
        }

        /**
         * If `sourceFile` is `undefined`, `node` must be a synthesized `TypeNode`.
         */
        function writeNode(hint: EmitHint, node: TypeNode, sourceFile: undefined, output: EmitTextWriter): void;
        function writeNode(hint: EmitHint, node: Node, sourceFile: SourceFile, output: EmitTextWriter): void;
        function writeNode(hint: EmitHint, node: Node, sourceFile: SourceFile | undefined, output: EmitTextWriter) {
            const previousWriter = writer;
            setWriter(output, /*_sourceMapGenerator*/ undefined);
            print(hint, node, sourceFile);
            reset();
            writer = previousWriter;
        }

        function writeList<T extends Node>(format: ListFormat, nodes: NodeArray<T>, sourceFile: SourceFile | undefined, output: EmitTextWriter) {
            const previousWriter = writer;
            setWriter(output, /*_sourceMapGenerator*/ undefined);
            if (sourceFile) {
                setSourceFile(sourceFile);
            }
            emitList(syntheticParent, nodes, format);
            reset();
            writer = previousWriter;
        }

        function writeBundle(bundle: Bundle, bundleInfo: BundleInfo | undefined, output: EmitTextWriter, sourceMapGenerator: SourceMapGenerator | undefined) {
            isOwnFileEmit = false;
            const previousWriter = writer;
            setWriter(output, sourceMapGenerator);
            emitShebangIfNeeded(bundle);
            emitPrologueDirectivesIfNeeded(bundle);
            emitHelpers(bundle);
            emitSyntheticTripleSlashReferencesIfNeeded(bundle);

            for (const prepend of bundle.prepends) {
                writeLine();
                print(EmitHint.Unspecified, prepend, /*sourceFile*/ undefined);
            }

            if (bundleInfo) {
                bundleInfo.originalOffset = writer.getTextPos();
            }

            for (const sourceFile of bundle.sourceFiles) {
                print(EmitHint.SourceFile, sourceFile, sourceFile);
            }
            reset();
            writer = previousWriter;
        }

        function writeUnparsedSource(unparsed: UnparsedSource, output: EmitTextWriter) {
            const previousWriter = writer;
            setWriter(output, /*_sourceMapGenerator*/ undefined);
            print(EmitHint.Unspecified, unparsed, /*sourceFile*/ undefined);
            reset();
            writer = previousWriter;
        }

        function writeFile(sourceFile: SourceFile, output: EmitTextWriter, sourceMapGenerator: SourceMapGenerator | undefined) {
            isOwnFileEmit = true;
            const previousWriter = writer;
            setWriter(output, sourceMapGenerator);
            emitShebangIfNeeded(sourceFile);
            emitPrologueDirectivesIfNeeded(sourceFile);
            print(EmitHint.SourceFile, sourceFile, sourceFile);
            reset();
            writer = previousWriter;
        }

        function beginPrint() {
            return ownWriter || (ownWriter = createTextWriter(newLine));
        }

        function endPrint() {
            const text = ownWriter.getText();
            ownWriter.clear();
            return text;
        }

        function print(hint: EmitHint, node: Node, sourceFile: SourceFile | undefined) {
            if (sourceFile) {
                setSourceFile(sourceFile);
            }

            const pipelinePhase = getPipelinePhase(PipelinePhase.Notification, node);
            pipelinePhase(hint, node);
        }

        function setSourceFile(sourceFile: SourceFile | undefined) {
            currentSourceFile = sourceFile;
            currentLineMap = undefined;
            detachedCommentsInfo = undefined;
            if (sourceFile) {
                setSourceMapSource(sourceFile);
            }
        }

        function setWriter(_writer: EmitTextWriter | undefined, _sourceMapGenerator: SourceMapGenerator | undefined) {
            if (_writer && printerOptions.omitTrailingSemicolon) {
                _writer = getTrailingSemicolonOmittingWriter(_writer);
            }

            writer = _writer!; // TODO: GH#18217
            sourceMapGenerator = _sourceMapGenerator;
            sourceMapsDisabled = !writer || !sourceMapGenerator;
        }

        function reset() {
            nodeIdToGeneratedName = [];
            autoGeneratedIdToGeneratedName = [];
            generatedNames = createMap<true>();
            tempFlagsStack = [];
            tempFlags = TempFlags.Auto;
            reservedNamesStack = [];
            currentSourceFile = undefined!;
            currentLineMap = undefined!;
            detachedCommentsInfo = undefined;
            setWriter(/*output*/ undefined, /*_sourceMapGenerator*/ undefined);
        }

        function getCurrentLineMap() {
            return currentLineMap || (currentLineMap = getLineStarts(currentSourceFile!));
        }

        function emit(node: Node | undefined) {
            if (node === undefined) return;
            const pipelinePhase = getPipelinePhase(PipelinePhase.Notification, node);
            pipelinePhase(EmitHint.Unspecified, node);
        }

        function emitIdentifierName(node: Identifier | undefined) {
            if (node === undefined) return;
            const pipelinePhase = getPipelinePhase(PipelinePhase.Notification, node);
            pipelinePhase(EmitHint.IdentifierName, node);
        }

        function emitExpression(node: Expression | undefined) {
            if (node === undefined) return;
            const pipelinePhase = getPipelinePhase(PipelinePhase.Notification, node);
            pipelinePhase(EmitHint.Expression, node);
        }

        function getPipelinePhase(phase: PipelinePhase, node: Node) {
            switch (phase) {
                case PipelinePhase.Notification:
                    if (onEmitNode !== noEmitNotification) {
                        return pipelineEmitWithNotification;
                    }
                    // falls through

                case PipelinePhase.Substitution:
                    if (substituteNode !== noEmitSubstitution) {
                        return pipelineEmitWithSubstitution;
                    }
                    // falls through

                case PipelinePhase.Comments:
                    if (!commentsDisabled && node.kind !== SyntaxKind.SourceFile) {
                        return pipelineEmitWithComments;
                    }
                    // falls through

                case PipelinePhase.SourceMaps:
                    if (!sourceMapsDisabled && node.kind !== SyntaxKind.SourceFile && !isInJsonFile(node)) {
                        return pipelineEmitWithSourceMap;
                    }
                    // falls through

                case PipelinePhase.Emit:
                    return pipelineEmitWithHint;

                default:
                    return Debug.assertNever(phase);
            }
        }

        function getNextPipelinePhase(currentPhase: PipelinePhase, node: Node) {
            return getPipelinePhase(currentPhase + 1, node);
        }

        function pipelineEmitWithNotification(hint: EmitHint, node: Node) {
            const pipelinePhase = getNextPipelinePhase(PipelinePhase.Notification, node);
            onEmitNode(hint, node, pipelinePhase);
        }

        function pipelineEmitWithHint(hint: EmitHint, node: Node): void {
            if (hint === EmitHint.SourceFile) return emitSourceFile(cast(node, isSourceFile));
            if (hint === EmitHint.IdentifierName) return emitIdentifier(cast(node, isIdentifier));
            if (hint === EmitHint.MappedTypeParameter) return emitMappedTypeParameter(cast(node, isTypeParameterDeclaration));
            if (hint === EmitHint.EmbeddedStatement) {
                Debug.assertNode(node, isEmptyStatement);
                return emitEmptyStatement(/*isEmbeddedStatement*/ true);
            }
            if (hint === EmitHint.Unspecified) {
                if (isKeyword(node.kind)) return writeTokenNode(node, writeKeyword);

                switch (node.kind) {
                    // Pseudo-literals
                    case SyntaxKind.TemplateHead:
                    case SyntaxKind.TemplateMiddle:
                    case SyntaxKind.TemplateTail:
                        return emitLiteral(<LiteralExpression>node);

                    case SyntaxKind.UnparsedSource:
                        return emitUnparsedSource(<UnparsedSource>node);

                    // Identifiers
                    case SyntaxKind.Identifier:
                        return emitIdentifier(<Identifier>node);

                    // Parse tree nodes

                    // Names
                    case SyntaxKind.QualifiedName:
                        return emitQualifiedName(<QualifiedName>node);
                    case SyntaxKind.ComputedPropertyName:
                        return emitComputedPropertyName(<ComputedPropertyName>node);

                    // Signature elements
                    case SyntaxKind.TypeParameter:
                        return emitTypeParameter(<TypeParameterDeclaration>node);
                    case SyntaxKind.Parameter:
                        return emitParameter(<ParameterDeclaration>node);
                    case SyntaxKind.Decorator:
                        return emitDecorator(<Decorator>node);

                    // Type members
                    case SyntaxKind.PropertySignature:
                        return emitPropertySignature(<PropertySignature>node);
                    case SyntaxKind.PropertyDeclaration:
                        return emitPropertyDeclaration(<PropertyDeclaration>node);
                    case SyntaxKind.MethodSignature:
                        return emitMethodSignature(<MethodSignature>node);
                    case SyntaxKind.MethodDeclaration:
                        return emitMethodDeclaration(<MethodDeclaration>node);
                    case SyntaxKind.Constructor:
                        return emitConstructor(<ConstructorDeclaration>node);
                    case SyntaxKind.GetAccessor:
                    case SyntaxKind.SetAccessor:
                        return emitAccessorDeclaration(<AccessorDeclaration>node);
                    case SyntaxKind.CallSignature:
                        return emitCallSignature(<CallSignatureDeclaration>node);
                    case SyntaxKind.ConstructSignature:
                        return emitConstructSignature(<ConstructSignatureDeclaration>node);
                    case SyntaxKind.IndexSignature:
                        return emitIndexSignature(<IndexSignatureDeclaration>node);

                    // Types
                    case SyntaxKind.TypePredicate:
                        return emitTypePredicate(<TypePredicateNode>node);
                    case SyntaxKind.TypeReference:
                        return emitTypeReference(<TypeReferenceNode>node);
                    case SyntaxKind.FunctionType:
                        return emitFunctionType(<FunctionTypeNode>node);
                    case SyntaxKind.JSDocFunctionType:
                        return emitJSDocFunctionType(node as JSDocFunctionType);
                    case SyntaxKind.ConstructorType:
                        return emitConstructorType(<ConstructorTypeNode>node);
                    case SyntaxKind.TypeQuery:
                        return emitTypeQuery(<TypeQueryNode>node);
                    case SyntaxKind.TypeLiteral:
                        return emitTypeLiteral(<TypeLiteralNode>node);
                    case SyntaxKind.ArrayType:
                        return emitArrayType(<ArrayTypeNode>node);
                    case SyntaxKind.TupleType:
                        return emitTupleType(<TupleTypeNode>node);
                    case SyntaxKind.OptionalType:
                        return emitOptionalType(<OptionalTypeNode>node);
                    case SyntaxKind.UnionType:
                        return emitUnionType(<UnionTypeNode>node);
                    case SyntaxKind.IntersectionType:
                        return emitIntersectionType(<IntersectionTypeNode>node);
                    case SyntaxKind.ConditionalType:
                        return emitConditionalType(<ConditionalTypeNode>node);
                    case SyntaxKind.InferType:
                        return emitInferType(<InferTypeNode>node);
                    case SyntaxKind.ParenthesizedType:
                        return emitParenthesizedType(<ParenthesizedTypeNode>node);
                    case SyntaxKind.ExpressionWithTypeArguments:
                        return emitExpressionWithTypeArguments(<ExpressionWithTypeArguments>node);
                    case SyntaxKind.ThisType:
                        return emitThisType();
                    case SyntaxKind.TypeOperator:
                        return emitTypeOperator(<TypeOperatorNode>node);
                    case SyntaxKind.IndexedAccessType:
                        return emitIndexedAccessType(<IndexedAccessTypeNode>node);
                    case SyntaxKind.MappedType:
                        return emitMappedType(<MappedTypeNode>node);
                    case SyntaxKind.LiteralType:
                        return emitLiteralType(<LiteralTypeNode>node);
                    case SyntaxKind.ImportType:
                        return emitImportTypeNode(<ImportTypeNode>node);
                    case SyntaxKind.JSDocAllType:
                        writePunctuation("*");
                        return;
                    case SyntaxKind.JSDocUnknownType:
                        writePunctuation("?");
                        return;
                    case SyntaxKind.JSDocNullableType:
                        return emitJSDocNullableType(node as JSDocNullableType);
                    case SyntaxKind.JSDocNonNullableType:
                        return emitJSDocNonNullableType(node as JSDocNonNullableType);
                    case SyntaxKind.JSDocOptionalType:
                        return emitJSDocOptionalType(node as JSDocOptionalType);
                    case SyntaxKind.RestType:
                    case SyntaxKind.JSDocVariadicType:
                        return emitRestOrJSDocVariadicType(node as RestTypeNode | JSDocVariadicType);

                    // Binding patterns
                    case SyntaxKind.ObjectBindingPattern:
                        return emitObjectBindingPattern(<ObjectBindingPattern>node);
                    case SyntaxKind.ArrayBindingPattern:
                        return emitArrayBindingPattern(<ArrayBindingPattern>node);
                    case SyntaxKind.BindingElement:
                        return emitBindingElement(<BindingElement>node);

                    // Misc
                    case SyntaxKind.TemplateSpan:
                        return emitTemplateSpan(<TemplateSpan>node);
                    case SyntaxKind.SemicolonClassElement:
                        return emitSemicolonClassElement();

                    // Statements
                    case SyntaxKind.Block:
                        return emitBlock(<Block>node);
                    case SyntaxKind.VariableStatement:
                        return emitVariableStatement(<VariableStatement>node);
                    case SyntaxKind.EmptyStatement:
                        return emitEmptyStatement(/*isEmbeddedStatement*/ false);
                    case SyntaxKind.ExpressionStatement:
                        return emitExpressionStatement(<ExpressionStatement>node);
                    case SyntaxKind.IfStatement:
                        return emitIfStatement(<IfStatement>node);
                    case SyntaxKind.DoStatement:
                        return emitDoStatement(<DoStatement>node);
                    case SyntaxKind.WhileStatement:
                        return emitWhileStatement(<WhileStatement>node);
                    case SyntaxKind.ForStatement:
                        return emitForStatement(<ForStatement>node);
                    case SyntaxKind.ForInStatement:
                        return emitForInStatement(<ForInStatement>node);
                    case SyntaxKind.ForOfStatement:
                        return emitForOfStatement(<ForOfStatement>node);
                    case SyntaxKind.ContinueStatement:
                        return emitContinueStatement(<ContinueStatement>node);
                    case SyntaxKind.BreakStatement:
                        return emitBreakStatement(<BreakStatement>node);
                    case SyntaxKind.ReturnStatement:
                        return emitReturnStatement(<ReturnStatement>node);
                    case SyntaxKind.WithStatement:
                        return emitWithStatement(<WithStatement>node);
                    case SyntaxKind.SwitchStatement:
                        return emitSwitchStatement(<SwitchStatement>node);
                    case SyntaxKind.LabeledStatement:
                        return emitLabeledStatement(<LabeledStatement>node);
                    case SyntaxKind.ThrowStatement:
                        return emitThrowStatement(<ThrowStatement>node);
                    case SyntaxKind.TryStatement:
                        return emitTryStatement(<TryStatement>node);
                    case SyntaxKind.DebuggerStatement:
                        return emitDebuggerStatement(<DebuggerStatement>node);

                    // Declarations
                    case SyntaxKind.VariableDeclaration:
                        return emitVariableDeclaration(<VariableDeclaration>node);
                    case SyntaxKind.VariableDeclarationList:
                        return emitVariableDeclarationList(<VariableDeclarationList>node);
                    case SyntaxKind.FunctionDeclaration:
                        return emitFunctionDeclaration(<FunctionDeclaration>node);
                    case SyntaxKind.ClassDeclaration:
                        return emitClassDeclaration(<ClassDeclaration>node);
                    case SyntaxKind.InterfaceDeclaration:
                        return emitInterfaceDeclaration(<InterfaceDeclaration>node);
                    case SyntaxKind.TypeAliasDeclaration:
                        return emitTypeAliasDeclaration(<TypeAliasDeclaration>node);
                    case SyntaxKind.EnumDeclaration:
                        return emitEnumDeclaration(<EnumDeclaration>node);
                    case SyntaxKind.ModuleDeclaration:
                        return emitModuleDeclaration(<ModuleDeclaration>node);
                    case SyntaxKind.ModuleBlock:
                        return emitModuleBlock(<ModuleBlock>node);
                    case SyntaxKind.CaseBlock:
                        return emitCaseBlock(<CaseBlock>node);
                    case SyntaxKind.NamespaceExportDeclaration:
                        return emitNamespaceExportDeclaration(<NamespaceExportDeclaration>node);
                    case SyntaxKind.ImportEqualsDeclaration:
                        return emitImportEqualsDeclaration(<ImportEqualsDeclaration>node);
                    case SyntaxKind.ImportDeclaration:
                        return emitImportDeclaration(<ImportDeclaration>node);
                    case SyntaxKind.ImportClause:
                        return emitImportClause(<ImportClause>node);
                    case SyntaxKind.NamespaceImport:
                        return emitNamespaceImport(<NamespaceImport>node);
                    case SyntaxKind.NamedImports:
                        return emitNamedImports(<NamedImports>node);
                    case SyntaxKind.ImportSpecifier:
                        return emitImportSpecifier(<ImportSpecifier>node);
                    case SyntaxKind.ExportAssignment:
                        return emitExportAssignment(<ExportAssignment>node);
                    case SyntaxKind.ExportDeclaration:
                        return emitExportDeclaration(<ExportDeclaration>node);
                    case SyntaxKind.NamedExports:
                        return emitNamedExports(<NamedExports>node);
                    case SyntaxKind.ExportSpecifier:
                        return emitExportSpecifier(<ExportSpecifier>node);
                    case SyntaxKind.MissingDeclaration:
                        return;

                    // Module references
                    case SyntaxKind.ExternalModuleReference:
                        return emitExternalModuleReference(<ExternalModuleReference>node);

                    // JSX (non-expression)
                    case SyntaxKind.JsxText:
                        return emitJsxText(<JsxText>node);
                    case SyntaxKind.JsxOpeningElement:
                    case SyntaxKind.JsxOpeningFragment:
                        return emitJsxOpeningElementOrFragment(<JsxOpeningElement>node);
                    case SyntaxKind.JsxClosingElement:
                    case SyntaxKind.JsxClosingFragment:
                        return emitJsxClosingElementOrFragment(<JsxClosingElement>node);
                    case SyntaxKind.JsxAttribute:
                        return emitJsxAttribute(<JsxAttribute>node);
                    case SyntaxKind.JsxAttributes:
                        return emitJsxAttributes(<JsxAttributes>node);
                    case SyntaxKind.JsxSpreadAttribute:
                        return emitJsxSpreadAttribute(<JsxSpreadAttribute>node);
                    case SyntaxKind.JsxExpression:
                        return emitJsxExpression(<JsxExpression>node);

                    // Clauses
                    case SyntaxKind.CaseClause:
                        return emitCaseClause(<CaseClause>node);
                    case SyntaxKind.DefaultClause:
                        return emitDefaultClause(<DefaultClause>node);
                    case SyntaxKind.HeritageClause:
                        return emitHeritageClause(<HeritageClause>node);
                    case SyntaxKind.CatchClause:
                        return emitCatchClause(<CatchClause>node);

                    // Property assignments
                    case SyntaxKind.PropertyAssignment:
                        return emitPropertyAssignment(<PropertyAssignment>node);
                    case SyntaxKind.ShorthandPropertyAssignment:
                        return emitShorthandPropertyAssignment(<ShorthandPropertyAssignment>node);
                    case SyntaxKind.SpreadAssignment:
                        return emitSpreadAssignment(node as SpreadAssignment);

                    // Enum
                    case SyntaxKind.EnumMember:
                        return emitEnumMember(<EnumMember>node);

                    // JSDoc nodes (only used in codefixes currently)
                    case SyntaxKind.JSDocParameterTag:
                    case SyntaxKind.JSDocPropertyTag:
                        return emitJSDocPropertyLikeTag(node as JSDocPropertyLikeTag);
                    case SyntaxKind.JSDocReturnTag:
                    case SyntaxKind.JSDocTypeTag:
                    case SyntaxKind.JSDocThisTag:
                    case SyntaxKind.JSDocEnumTag:
                        return emitJSDocSimpleTypedTag(node as JSDocTypeTag);
                    case SyntaxKind.JSDocAugmentsTag:
                        return emitJSDocAugmentsTag(node as JSDocAugmentsTag);
                    case SyntaxKind.JSDocTemplateTag:
                        return emitJSDocTemplateTag(node as JSDocTemplateTag);
                    case SyntaxKind.JSDocTypedefTag:
                        return emitJSDocTypedefTag(node as JSDocTypedefTag);
                    case SyntaxKind.JSDocCallbackTag:
                        return emitJSDocCallbackTag(node as JSDocCallbackTag);
                    case SyntaxKind.JSDocSignature:
                        return emitJSDocSignature(node as JSDocSignature);
                    case SyntaxKind.JSDocTypeLiteral:
                        return emitJSDocTypeLiteral(node as JSDocTypeLiteral);
                    case SyntaxKind.JSDocClassTag:
                    case SyntaxKind.JSDocTag:
                        return emitJSDocSimpleTag(node as JSDocTag);

                    case SyntaxKind.JSDocComment:
                        return emitJSDoc(node as JSDoc);

                    // Transformation nodes (ignored)
                }

                if (isExpression(node)) {
                    hint = EmitHint.Expression;
                    if (substituteNode !== noEmitSubstitution) {
                        node = substituteNode(hint, node);
                    }
                }
                else if (isToken(node)) {
                    return writeTokenNode(node, writePunctuation);
                }
            }
            if (hint === EmitHint.Expression) {
                switch (node.kind) {
                    // Literals
                    case SyntaxKind.NumericLiteral:
                    case SyntaxKind.BigIntLiteral:
                        return emitNumericOrBigIntLiteral(<NumericLiteral | BigIntLiteral>node);

                    case SyntaxKind.StringLiteral:
                    case SyntaxKind.RegularExpressionLiteral:
                    case SyntaxKind.NoSubstitutionTemplateLiteral:
                        return emitLiteral(<LiteralExpression>node);

                    // Identifiers
                    case SyntaxKind.Identifier:
                        return emitIdentifier(<Identifier>node);

                    // Reserved words
                    case SyntaxKind.FalseKeyword:
                    case SyntaxKind.NullKeyword:
                    case SyntaxKind.SuperKeyword:
                    case SyntaxKind.TrueKeyword:
                    case SyntaxKind.ThisKeyword:
                    case SyntaxKind.ImportKeyword:
                        writeTokenNode(node, writeKeyword);
                        return;

                    // Expressions
                    case SyntaxKind.ArrayLiteralExpression:
                        return emitArrayLiteralExpression(<ArrayLiteralExpression>node);
                    case SyntaxKind.ObjectLiteralExpression:
                        return emitObjectLiteralExpression(<ObjectLiteralExpression>node);
                    case SyntaxKind.PropertyAccessExpression:
                        return emitPropertyAccessExpression(<PropertyAccessExpression>node);
                    case SyntaxKind.ElementAccessExpression:
                        return emitElementAccessExpression(<ElementAccessExpression>node);
                    case SyntaxKind.CallExpression:
                        return emitCallExpression(<CallExpression>node);
                    case SyntaxKind.NewExpression:
                        return emitNewExpression(<NewExpression>node);
                    case SyntaxKind.TaggedTemplateExpression:
                        return emitTaggedTemplateExpression(<TaggedTemplateExpression>node);
                    case SyntaxKind.TypeAssertionExpression:
                        return emitTypeAssertionExpression(<TypeAssertion>node);
                    case SyntaxKind.ParenthesizedExpression:
                        return emitParenthesizedExpression(<ParenthesizedExpression>node);
                    case SyntaxKind.FunctionExpression:
                        return emitFunctionExpression(<FunctionExpression>node);
                    case SyntaxKind.ArrowFunction:
                        return emitArrowFunction(<ArrowFunction>node);
                    case SyntaxKind.DeleteExpression:
                        return emitDeleteExpression(<DeleteExpression>node);
                    case SyntaxKind.TypeOfExpression:
                        return emitTypeOfExpression(<TypeOfExpression>node);
                    case SyntaxKind.VoidExpression:
                        return emitVoidExpression(<VoidExpression>node);
                    case SyntaxKind.AwaitExpression:
                        return emitAwaitExpression(<AwaitExpression>node);
                    case SyntaxKind.PrefixUnaryExpression:
                        return emitPrefixUnaryExpression(<PrefixUnaryExpression>node);
                    case SyntaxKind.PostfixUnaryExpression:
                        return emitPostfixUnaryExpression(<PostfixUnaryExpression>node);
                    case SyntaxKind.BinaryExpression:
                        return emitBinaryExpression(<BinaryExpression>node);
                    case SyntaxKind.ConditionalExpression:
                        return emitConditionalExpression(<ConditionalExpression>node);
                    case SyntaxKind.TemplateExpression:
                        return emitTemplateExpression(<TemplateExpression>node);
                    case SyntaxKind.YieldExpression:
                        return emitYieldExpression(<YieldExpression>node);
                    case SyntaxKind.SpreadElement:
                        return emitSpreadExpression(<SpreadElement>node);
                    case SyntaxKind.ClassExpression:
                        return emitClassExpression(<ClassExpression>node);
                    case SyntaxKind.OmittedExpression:
                        return;
                    case SyntaxKind.AsExpression:
                        return emitAsExpression(<AsExpression>node);
                    case SyntaxKind.NonNullExpression:
                        return emitNonNullExpression(<NonNullExpression>node);
                    case SyntaxKind.MetaProperty:
                        return emitMetaProperty(<MetaProperty>node);

                    // JSX
                    case SyntaxKind.JsxElement:
                        return emitJsxElement(<JsxElement>node);
                    case SyntaxKind.JsxSelfClosingElement:
                        return emitJsxSelfClosingElement(<JsxSelfClosingElement>node);
                    case SyntaxKind.JsxFragment:
                        return emitJsxFragment(<JsxFragment>node);

                    // Transformation nodes
                    case SyntaxKind.PartiallyEmittedExpression:
                        return emitPartiallyEmittedExpression(<PartiallyEmittedExpression>node);

                    case SyntaxKind.CommaListExpression:
                        return emitCommaList(<CommaListExpression>node);
                }
            }
        }

        function emitMappedTypeParameter(node: TypeParameterDeclaration): void {
            emit(node.name);
            writeSpace();
            writeKeyword("in");
            writeSpace();
            emit(node.constraint);
        }

        function pipelineEmitWithSubstitution(hint: EmitHint, node: Node) {
            const pipelinePhase = getNextPipelinePhase(PipelinePhase.Substitution, node);
            pipelinePhase(hint, substituteNode(hint, node));
        }

        function emitHelpers(node: Node) {
            let helpersEmitted = false;
            const bundle = node.kind === SyntaxKind.Bundle ? <Bundle>node : undefined;
            if (bundle && moduleKind === ModuleKind.None) {
                return;
            }

            const numNodes = bundle ? bundle.sourceFiles.length : 1;
            for (let i = 0; i < numNodes; i++) {
                const currentNode = bundle ? bundle.sourceFiles[i] : node;
                const sourceFile = isSourceFile(currentNode) ? currentNode : currentSourceFile!;
                const shouldSkip = printerOptions.noEmitHelpers || getExternalHelpersModuleName(sourceFile) !== undefined;
                const shouldBundle = isSourceFile(currentNode) && !isOwnFileEmit;
                const helpers = getEmitHelpers(currentNode);
                if (helpers) {
                    for (const helper of stableSort(helpers, compareEmitHelpers)) {
                        if (!helper.scoped) {
                            // Skip the helper if it can be skipped and the noEmitHelpers compiler
                            // option is set, or if it can be imported and the importHelpers compiler
                            // option is set.
                            if (shouldSkip) continue;

                            // Skip the helper if it can be bundled but hasn't already been emitted and we
                            // are emitting a bundled module.
                            if (shouldBundle) {
                                if (bundledHelpers.get(helper.name)) {
                                    continue;
                                }

                                bundledHelpers.set(helper.name, true);
                            }
                        }
                        else if (bundle) {
                            // Skip the helper if it is scoped and we are emitting bundled helpers
                            continue;
                        }

                        if (typeof helper.text === "string") {
                            writeLines(helper.text);
                        }
                        else {
                            writeLines(helper.text(makeFileLevelOptimisticUniqueName));
                        }
                        helpersEmitted = true;
                    }
                }
            }

            return helpersEmitted;
        }

        //
        // Literals/Pseudo-literals
        //

        // SyntaxKind.NumericLiteral
        // SyntaxKind.BigIntLiteral
        function emitNumericOrBigIntLiteral(node: NumericLiteral | BigIntLiteral) {
            emitLiteral(node);
        }

        // SyntaxKind.StringLiteral
        // SyntaxKind.RegularExpressionLiteral
        // SyntaxKind.NoSubstitutionTemplateLiteral
        // SyntaxKind.TemplateHead
        // SyntaxKind.TemplateMiddle
        // SyntaxKind.TemplateTail
        function emitLiteral(node: LiteralLikeNode) {
            const text = getLiteralTextOfNode(node, printerOptions.neverAsciiEscape);
            if ((printerOptions.sourceMap || printerOptions.inlineSourceMap)
                && (node.kind === SyntaxKind.StringLiteral || isTemplateLiteralKind(node.kind))) {
                writeLiteral(text);
            }
            else {
                // Quick info expects all literals to be called with writeStringLiteral, as there's no specific type for numberLiterals
                writeStringLiteral(text);
            }
        }

        // SyntaxKind.UnparsedSource
        function emitUnparsedSource(unparsed: UnparsedSource) {
            writer.rawWrite(unparsed.text);
        }

        //
        // Identifiers
        //

        function emitIdentifier(node: Identifier) {
            const writeText = node.symbol ? writeSymbol : write;
            writeText(getTextOfNode(node, /*includeTrivia*/ false), node.symbol);
            emitList(node, node.typeArguments, ListFormat.TypeParameters); // Call emitList directly since it could be an array of TypeParameterDeclarations _or_ type arguments
        }

        //
        // Names
        //

        function emitQualifiedName(node: QualifiedName) {
            emitEntityName(node.left);
            writePunctuation(".");
            emit(node.right);
        }

        function emitEntityName(node: EntityName) {
            if (node.kind === SyntaxKind.Identifier) {
                emitExpression(node);
            }
            else {
                emit(node);
            }
        }

        function emitComputedPropertyName(node: ComputedPropertyName) {
            writePunctuation("[");
            emitExpression(node.expression);
            writePunctuation("]");
        }

        //
        // Signature elements
        //

        function emitTypeParameter(node: TypeParameterDeclaration) {
            emit(node.name);
            if (node.constraint) {
                writeSpace();
                writeKeyword("extends");
                writeSpace();
                emit(node.constraint);
            }
            if (node.default) {
                writeSpace();
                writeOperator("=");
                writeSpace();
                emit(node.default);
            }
        }

        function emitParameter(node: ParameterDeclaration) {
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            emit(node.dotDotDotToken);
            emitNodeWithWriter(node.name, writeParameter);
            emit(node.questionToken);
            if (node.parent && node.parent.kind === SyntaxKind.JSDocFunctionType && !node.name) {
                emit(node.type);
            }
            else {
                emitTypeAnnotation(node.type);
            }
            // The comment position has to fallback to any present node within the parameterdeclaration because as it turns out, the parser can make parameter declarations with _just_ an initializer.
            emitInitializer(node.initializer, node.type ? node.type.end : node.questionToken ? node.questionToken.end : node.name ? node.name.end : node.modifiers ? node.modifiers.end : node.decorators ? node.decorators.end : node.pos, node);
        }

        function emitDecorator(decorator: Decorator) {
            writePunctuation("@");
            emitExpression(decorator.expression);
        }

        //
        // Type members
        //

        function emitPropertySignature(node: PropertySignature) {
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            emitNodeWithWriter(node.name, writeProperty);
            emit(node.questionToken);
            emitTypeAnnotation(node.type);
            writeTrailingSemicolon();
        }

        function emitPropertyDeclaration(node: PropertyDeclaration) {
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            emit(node.name);
            emit(node.questionToken);
            emit(node.exclamationToken);
            emitTypeAnnotation(node.type);
            emitInitializer(node.initializer, node.type ? node.type.end : node.questionToken ? node.questionToken.end : node.name.end, node);
            writeTrailingSemicolon();
        }

        function emitMethodSignature(node: MethodSignature) {
            pushNameGenerationScope(node);
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            emit(node.name);
            emit(node.questionToken);
            emitTypeParameters(node, node.typeParameters);
            emitParameters(node, node.parameters);
            emitTypeAnnotation(node.type);
            writeTrailingSemicolon();
            popNameGenerationScope(node);
        }

        function emitMethodDeclaration(node: MethodDeclaration) {
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            emit(node.asteriskToken);
            emit(node.name);
            emit(node.questionToken);
            emitSignatureAndBody(node, emitSignatureHead);
        }

        function emitConstructor(node: ConstructorDeclaration) {
            emitModifiers(node, node.modifiers);
            writeKeyword("constructor");
            emitSignatureAndBody(node, emitSignatureHead);
        }

        function emitAccessorDeclaration(node: AccessorDeclaration) {
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            writeKeyword(node.kind === SyntaxKind.GetAccessor ? "get" : "set");
            writeSpace();
            emit(node.name);
            emitSignatureAndBody(node, emitSignatureHead);
        }

        function emitCallSignature(node: CallSignatureDeclaration) {
            pushNameGenerationScope(node);
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            emitTypeParameters(node, node.typeParameters);
            emitParameters(node, node.parameters);
            emitTypeAnnotation(node.type);
            writeTrailingSemicolon();
            popNameGenerationScope(node);
        }

        function emitConstructSignature(node: ConstructSignatureDeclaration) {
            pushNameGenerationScope(node);
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            writeKeyword("new");
            writeSpace();
            emitTypeParameters(node, node.typeParameters);
            emitParameters(node, node.parameters);
            emitTypeAnnotation(node.type);
            writeTrailingSemicolon();
            popNameGenerationScope(node);
        }

        function emitIndexSignature(node: IndexSignatureDeclaration) {
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            emitParametersForIndexSignature(node, node.parameters);
            emitTypeAnnotation(node.type);
            writeTrailingSemicolon();
        }

        function emitSemicolonClassElement() {
            writeTrailingSemicolon();
        }

        //
        // Types
        //

        function emitTypePredicate(node: TypePredicateNode) {
            emit(node.parameterName);
            writeSpace();
            writeKeyword("is");
            writeSpace();
            emit(node.type);
        }

        function emitTypeReference(node: TypeReferenceNode) {
            emit(node.typeName);
            emitTypeArguments(node, node.typeArguments);
        }

        function emitFunctionType(node: FunctionTypeNode) {
            pushNameGenerationScope(node);
            emitTypeParameters(node, node.typeParameters);
            emitParametersForArrow(node, node.parameters);
            writeSpace();
            writePunctuation("=>");
            writeSpace();
            emit(node.type);
            popNameGenerationScope(node);
        }

        function emitJSDocFunctionType(node: JSDocFunctionType) {
            writeKeyword("function");
            emitParameters(node, node.parameters);
            writePunctuation(":");
            emit(node.type);
        }


        function emitJSDocNullableType(node: JSDocNullableType) {
            writePunctuation("?");
            emit(node.type);
        }

        function emitJSDocNonNullableType(node: JSDocNonNullableType) {
            writePunctuation("!");
            emit(node.type);
        }

        function emitJSDocOptionalType(node: JSDocOptionalType) {
            emit(node.type);
            writePunctuation("=");
        }

        function emitConstructorType(node: ConstructorTypeNode) {
            pushNameGenerationScope(node);
            writeKeyword("new");
            writeSpace();
            emitTypeParameters(node, node.typeParameters);
            emitParameters(node, node.parameters);
            writeSpace();
            writePunctuation("=>");
            writeSpace();
            emit(node.type);
            popNameGenerationScope(node);
        }

        function emitTypeQuery(node: TypeQueryNode) {
            writeKeyword("typeof");
            writeSpace();
            emit(node.exprName);
        }

        function emitTypeLiteral(node: TypeLiteralNode) {
            writePunctuation("{");
            const flags = getEmitFlags(node) & EmitFlags.SingleLine ? ListFormat.SingleLineTypeLiteralMembers : ListFormat.MultiLineTypeLiteralMembers;
            emitList(node, node.members, flags | ListFormat.NoSpaceIfEmpty);
            writePunctuation("}");
        }

        function emitArrayType(node: ArrayTypeNode) {
            emit(node.elementType);
            writePunctuation("[");
            writePunctuation("]");
        }

        function emitRestOrJSDocVariadicType(node: RestTypeNode | JSDocVariadicType) {
            writePunctuation("...");
            emit(node.type);
        }

        function emitTupleType(node: TupleTypeNode) {
            writePunctuation("[");
            emitList(node, node.elementTypes, ListFormat.TupleTypeElements);
            writePunctuation("]");
        }

        function emitOptionalType(node: OptionalTypeNode) {
            emit(node.type);
            writePunctuation("?");
        }

        function emitUnionType(node: UnionTypeNode) {
            emitList(node, node.types, ListFormat.UnionTypeConstituents);
        }

        function emitIntersectionType(node: IntersectionTypeNode) {
            emitList(node, node.types, ListFormat.IntersectionTypeConstituents);
        }

        function emitConditionalType(node: ConditionalTypeNode) {
            emit(node.checkType);
            writeSpace();
            writeKeyword("extends");
            writeSpace();
            emit(node.extendsType);
            writeSpace();
            writePunctuation("?");
            writeSpace();
            emit(node.trueType);
            writeSpace();
            writePunctuation(":");
            writeSpace();
            emit(node.falseType);
        }

        function emitInferType(node: InferTypeNode) {
            writeKeyword("infer");
            writeSpace();
            emit(node.typeParameter);
        }

        function emitParenthesizedType(node: ParenthesizedTypeNode) {
            writePunctuation("(");
            emit(node.type);
            writePunctuation(")");
        }

        function emitThisType() {
            writeKeyword("this");
        }

        function emitTypeOperator(node: TypeOperatorNode) {
            writeTokenText(node.operator, writeKeyword);
            writeSpace();
            emit(node.type);
        }

        function emitIndexedAccessType(node: IndexedAccessTypeNode) {
            emit(node.objectType);
            writePunctuation("[");
            emit(node.indexType);
            writePunctuation("]");
        }

        function emitMappedType(node: MappedTypeNode) {
            const emitFlags = getEmitFlags(node);
            writePunctuation("{");
            if (emitFlags & EmitFlags.SingleLine) {
                writeSpace();
            }
            else {
                writeLine();
                increaseIndent();
            }
            if (node.readonlyToken) {
                emit(node.readonlyToken);
                if (node.readonlyToken.kind !== SyntaxKind.ReadonlyKeyword) {
                    writeKeyword("readonly");
                }
                writeSpace();
            }
            writePunctuation("[");

            const pipelinePhase = getPipelinePhase(PipelinePhase.Notification, node.typeParameter);
            pipelinePhase(EmitHint.MappedTypeParameter, node.typeParameter);

            writePunctuation("]");
            if (node.questionToken) {
                emit(node.questionToken);
                if (node.questionToken.kind !== SyntaxKind.QuestionToken) {
                    writePunctuation("?");
                }
            }
            writePunctuation(":");
            writeSpace();
            emit(node.type);
            writeTrailingSemicolon();
            if (emitFlags & EmitFlags.SingleLine) {
                writeSpace();
            }
            else {
                writeLine();
                decreaseIndent();
            }
            writePunctuation("}");
        }

        function emitLiteralType(node: LiteralTypeNode) {
            emitExpression(node.literal);
        }

        function emitImportTypeNode(node: ImportTypeNode) {
            if (node.isTypeOf) {
                writeKeyword("typeof");
                writeSpace();
            }
            writeKeyword("import");
            writePunctuation("(");
            emit(node.argument);
            writePunctuation(")");
            if (node.qualifier) {
                writePunctuation(".");
                emit(node.qualifier);
            }
            emitTypeArguments(node, node.typeArguments);
        }

        //
        // Binding patterns
        //

        function emitObjectBindingPattern(node: ObjectBindingPattern) {
            writePunctuation("{");
            emitList(node, node.elements, ListFormat.ObjectBindingPatternElements);
            writePunctuation("}");
        }

        function emitArrayBindingPattern(node: ArrayBindingPattern) {
            writePunctuation("[");
            emitList(node, node.elements, ListFormat.ArrayBindingPatternElements);
            writePunctuation("]");
        }

        function emitBindingElement(node: BindingElement) {
            emit(node.dotDotDotToken);
            if (node.propertyName) {
                emit(node.propertyName);
                writePunctuation(":");
                writeSpace();
            }
            emit(node.name);
            emitInitializer(node.initializer, node.name.end, node);
        }

        //
        // Expressions
        //

        function emitArrayLiteralExpression(node: ArrayLiteralExpression) {
            const elements = node.elements;
            const preferNewLine = node.multiLine ? ListFormat.PreferNewLine : ListFormat.None;
            emitExpressionList(node, elements, ListFormat.ArrayLiteralExpressionElements | preferNewLine);
        }

        function emitObjectLiteralExpression(node: ObjectLiteralExpression) {
            forEach(node.properties, generateMemberNames);

            const indentedFlag = getEmitFlags(node) & EmitFlags.Indented;
            if (indentedFlag) {
                increaseIndent();
            }

            const preferNewLine = node.multiLine ? ListFormat.PreferNewLine : ListFormat.None;
            const allowTrailingComma = currentSourceFile!.languageVersion >= ScriptTarget.ES5 && !isJsonSourceFile(currentSourceFile!) ? ListFormat.AllowTrailingComma : ListFormat.None;
            emitList(node, node.properties, ListFormat.ObjectLiteralExpressionProperties | allowTrailingComma | preferNewLine);

            if (indentedFlag) {
                decreaseIndent();
            }
        }

        function emitPropertyAccessExpression(node: PropertyAccessExpression) {
            let indentBeforeDot = false;
            let indentAfterDot = false;
            const dotRangeFirstCommentStart = skipTrivia(
                currentSourceFile!.text,
                node.expression.end,
                /*stopAfterLineBreak*/ false,
                /*stopAtComments*/ true
            );
            const dotRangeStart = skipTrivia(currentSourceFile!.text, dotRangeFirstCommentStart);
            const dotRangeEnd = dotRangeStart + 1;
            if (!(getEmitFlags(node) & EmitFlags.NoIndentation)) {
                const dotToken = createToken(SyntaxKind.DotToken);
                dotToken.pos = node.expression.end;
                dotToken.end = dotRangeEnd;
                indentBeforeDot = needsIndentation(node, node.expression, dotToken);
                indentAfterDot = needsIndentation(node, dotToken, node.name);
            }

            emitExpression(node.expression);
            increaseIndentIf(indentBeforeDot, /*writeSpaceIfNotIndenting*/ false);

            const dotHasCommentTrivia = dotRangeFirstCommentStart !== dotRangeStart;
            const shouldEmitDotDot = !indentBeforeDot && needsDotDotForPropertyAccess(node.expression, dotHasCommentTrivia);
            if (shouldEmitDotDot) {
                writePunctuation(".");
            }
            emitTokenWithComment(SyntaxKind.DotToken, node.expression.end, writePunctuation, node);

            increaseIndentIf(indentAfterDot, /*writeSpaceIfNotIndenting*/ false);
            emit(node.name);
            decreaseIndentIf(indentBeforeDot, indentAfterDot);
        }

        // 1..toString is a valid property access, emit a dot after the literal
        // Also emit a dot if expression is a integer const enum value - it will appear in generated code as numeric literal
        function needsDotDotForPropertyAccess(expression: Expression, dotHasTrivia: boolean) {
            expression = skipPartiallyEmittedExpressions(expression);
            if (isNumericLiteral(expression)) {
                // check if numeric literal is a decimal literal that was originally written with a dot
                const text = getLiteralTextOfNode(<LiteralExpression>expression, /*neverAsciiEscape*/ true);
                // If he number will be printed verbatim and it doesn't already contain a dot, add one
                // if the expression doesn't have any comments that will be emitted.
                return !expression.numericLiteralFlags && !stringContains(text, tokenToString(SyntaxKind.DotToken)!) &&
                    (!dotHasTrivia || printerOptions.removeComments);
            }
            else if (isPropertyAccessExpression(expression) || isElementAccessExpression(expression)) {
                // check if constant enum value is integer
                const constantValue = getConstantValue(expression);
                // isFinite handles cases when constantValue is undefined
                return typeof constantValue === "number" && isFinite(constantValue)
                    && Math.floor(constantValue) === constantValue
                    && printerOptions.removeComments;
            }
        }

        function emitElementAccessExpression(node: ElementAccessExpression) {
            emitExpression(node.expression);
            emitTokenWithComment(SyntaxKind.OpenBracketToken, node.expression.end, writePunctuation, node);
            emitExpression(node.argumentExpression);
            emitTokenWithComment(SyntaxKind.CloseBracketToken, node.argumentExpression.end, writePunctuation, node);
        }

        function emitCallExpression(node: CallExpression) {
            emitExpression(node.expression);
            emitTypeArguments(node, node.typeArguments);
            emitExpressionList(node, node.arguments, ListFormat.CallExpressionArguments);
        }

        function emitNewExpression(node: NewExpression) {
            emitTokenWithComment(SyntaxKind.NewKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emitExpression(node.expression);
            emitTypeArguments(node, node.typeArguments);
            emitExpressionList(node, node.arguments, ListFormat.NewExpressionArguments);
        }

        function emitTaggedTemplateExpression(node: TaggedTemplateExpression) {
            emitExpression(node.tag);
            emitTypeArguments(node, node.typeArguments);
            writeSpace();
            emitExpression(node.template);
        }

        function emitTypeAssertionExpression(node: TypeAssertion) {
            writePunctuation("<");
            emit(node.type);
            writePunctuation(">");
            emitExpression(node.expression);
        }

        function emitParenthesizedExpression(node: ParenthesizedExpression) {
            const openParenPos = emitTokenWithComment(SyntaxKind.OpenParenToken, node.pos, writePunctuation, node);
            emitExpression(node.expression);
            emitTokenWithComment(SyntaxKind.CloseParenToken, node.expression ? node.expression.end : openParenPos, writePunctuation, node);
        }

        function emitFunctionExpression(node: FunctionExpression) {
            generateNameIfNeeded(node.name);
            emitFunctionDeclarationOrExpression(node);
        }

        function emitArrowFunction(node: ArrowFunction) {
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            emitSignatureAndBody(node, emitArrowFunctionHead);
        }

        function emitArrowFunctionHead(node: ArrowFunction) {
            emitTypeParameters(node, node.typeParameters);
            emitParametersForArrow(node, node.parameters);
            emitTypeAnnotation(node.type);
            writeSpace();
            emit(node.equalsGreaterThanToken);
        }

        function emitDeleteExpression(node: DeleteExpression) {
            emitTokenWithComment(SyntaxKind.DeleteKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emitExpression(node.expression);
        }

        function emitTypeOfExpression(node: TypeOfExpression) {
            emitTokenWithComment(SyntaxKind.TypeOfKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emitExpression(node.expression);
        }

        function emitVoidExpression(node: VoidExpression) {
            emitTokenWithComment(SyntaxKind.VoidKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emitExpression(node.expression);
        }

        function emitAwaitExpression(node: AwaitExpression) {
            emitTokenWithComment(SyntaxKind.AwaitKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emitExpression(node.expression);
        }

        function emitPrefixUnaryExpression(node: PrefixUnaryExpression) {
            writeTokenText(node.operator, writeOperator);
            if (shouldEmitWhitespaceBeforeOperand(node)) {
                writeSpace();
            }
            emitExpression(node.operand);
        }

        function shouldEmitWhitespaceBeforeOperand(node: PrefixUnaryExpression) {
            // In some cases, we need to emit a space between the operator and the operand. One obvious case
            // is when the operator is an identifier, like delete or typeof. We also need to do this for plus
            // and minus expressions in certain cases. Specifically, consider the following two cases (parens
            // are just for clarity of exposition, and not part of the source code):
            //
            //  (+(+1))
            //  (+(++1))
            //
            // We need to emit a space in both cases. In the first case, the absence of a space will make
            // the resulting expression a prefix increment operation. And in the second, it will make the resulting
            // expression a prefix increment whose operand is a plus expression - (++(+x))
            // The same is true of minus of course.
            const operand = node.operand;
            return operand.kind === SyntaxKind.PrefixUnaryExpression
                && ((node.operator === SyntaxKind.PlusToken && ((<PrefixUnaryExpression>operand).operator === SyntaxKind.PlusToken || (<PrefixUnaryExpression>operand).operator === SyntaxKind.PlusPlusToken))
                    || (node.operator === SyntaxKind.MinusToken && ((<PrefixUnaryExpression>operand).operator === SyntaxKind.MinusToken || (<PrefixUnaryExpression>operand).operator === SyntaxKind.MinusMinusToken)));
        }

        function emitPostfixUnaryExpression(node: PostfixUnaryExpression) {
            emitExpression(node.operand);
            writeTokenText(node.operator, writeOperator);
        }

        function emitBinaryExpression(node: BinaryExpression) {
            const isCommaOperator = node.operatorToken.kind !== SyntaxKind.CommaToken;
            const indentBeforeOperator = needsIndentation(node, node.left, node.operatorToken);
            const indentAfterOperator = needsIndentation(node, node.operatorToken, node.right);

            emitExpression(node.left);
            increaseIndentIf(indentBeforeOperator, isCommaOperator);
            emitLeadingCommentsOfPosition(node.operatorToken.pos);
            writeTokenNode(node.operatorToken, node.operatorToken.kind === SyntaxKind.InKeyword ? writeKeyword : writeOperator);
            emitTrailingCommentsOfPosition(node.operatorToken.end, /*prefixSpace*/ true); // Binary operators should have a space before the comment starts
            increaseIndentIf(indentAfterOperator, /*writeSpaceIfNotIndenting*/ true);
            emitExpression(node.right);
            decreaseIndentIf(indentBeforeOperator, indentAfterOperator);
        }

        function emitConditionalExpression(node: ConditionalExpression) {
            const indentBeforeQuestion = needsIndentation(node, node.condition, node.questionToken);
            const indentAfterQuestion = needsIndentation(node, node.questionToken, node.whenTrue);
            const indentBeforeColon = needsIndentation(node, node.whenTrue, node.colonToken);
            const indentAfterColon = needsIndentation(node, node.colonToken, node.whenFalse);

            emitExpression(node.condition);
            increaseIndentIf(indentBeforeQuestion, /*writeSpaceIfNotIndenting*/ true);
            emit(node.questionToken);
            increaseIndentIf(indentAfterQuestion, /*writeSpaceIfNotIndenting*/ true);
            emitExpression(node.whenTrue);
            decreaseIndentIf(indentBeforeQuestion, indentAfterQuestion);

            increaseIndentIf(indentBeforeColon, /*writeSpaceIfNotIndenting*/ true);
            emit(node.colonToken);
            increaseIndentIf(indentAfterColon, /*writeSpaceIfNotIndenting*/ true);
            emitExpression(node.whenFalse);
            decreaseIndentIf(indentBeforeColon, indentAfterColon);
        }

        function emitTemplateExpression(node: TemplateExpression) {
            emit(node.head);
            emitList(node, node.templateSpans, ListFormat.TemplateExpressionSpans);
        }

        function emitYieldExpression(node: YieldExpression) {
            emitTokenWithComment(SyntaxKind.YieldKeyword, node.pos, writeKeyword, node);
            emit(node.asteriskToken);
            emitExpressionWithLeadingSpace(node.expression);
        }

        function emitSpreadExpression(node: SpreadElement) {
            emitTokenWithComment(SyntaxKind.DotDotDotToken, node.pos, writePunctuation, node);
            emitExpression(node.expression);
        }

        function emitClassExpression(node: ClassExpression) {
            generateNameIfNeeded(node.name);
            emitClassDeclarationOrExpression(node);
        }

        function emitExpressionWithTypeArguments(node: ExpressionWithTypeArguments) {
            emitExpression(node.expression);
            emitTypeArguments(node, node.typeArguments);
        }

        function emitAsExpression(node: AsExpression) {
            emitExpression(node.expression);
            if (node.type) {
                writeSpace();
                writeKeyword("as");
                writeSpace();
                emit(node.type);
            }
        }

        function emitNonNullExpression(node: NonNullExpression) {
            emitExpression(node.expression);
            writeOperator("!");
        }

        function emitMetaProperty(node: MetaProperty) {
            writeToken(node.keywordToken, node.pos, writePunctuation);
            writePunctuation(".");
            emit(node.name);
        }

        //
        // Misc
        //

        function emitTemplateSpan(node: TemplateSpan) {
            emitExpression(node.expression);
            emit(node.literal);
        }

        //
        // Statements
        //

        function emitBlock(node: Block) {
            emitBlockStatements(node, /*forceSingleLine*/ !node.multiLine && isEmptyBlock(node));
        }

        function emitBlockStatements(node: BlockLike, forceSingleLine: boolean) {
            emitTokenWithComment(SyntaxKind.OpenBraceToken, node.pos, writePunctuation, /*contextNode*/ node);
            const format = forceSingleLine || getEmitFlags(node) & EmitFlags.SingleLine ? ListFormat.SingleLineBlockStatements : ListFormat.MultiLineBlockStatements;
            emitList(node, node.statements, format);
            emitTokenWithComment(SyntaxKind.CloseBraceToken, node.statements.end, writePunctuation, /*contextNode*/ node, /*indentLeading*/ !!(format & ListFormat.MultiLine));
        }

        function emitVariableStatement(node: VariableStatement) {
            emitModifiers(node, node.modifiers);
            emit(node.declarationList);
            writeTrailingSemicolon();
        }

        function emitEmptyStatement(isEmbeddedStatement: boolean) {
            // While most trailing semicolons are possibly insignificant, an embedded "empty"
            // statement is significant and cannot be elided by a trailing-semicolon-omitting writer.
            if (isEmbeddedStatement) {
                writePunctuation(";");
            }
            else {
                writeTrailingSemicolon();
            }
        }


        function emitExpressionStatement(node: ExpressionStatement) {
            emitExpression(node.expression);
            // Emit semicolon in non json files
            // or if json file that created synthesized expression(eg.define expression statement when --out and amd code generation)
            if (!isJsonSourceFile(currentSourceFile!) || nodeIsSynthesized(node.expression)) {
                writeTrailingSemicolon();
            }
        }

        function emitIfStatement(node: IfStatement) {
            const openParenPos = emitTokenWithComment(SyntaxKind.IfKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emitTokenWithComment(SyntaxKind.OpenParenToken, openParenPos, writePunctuation, node);
            emitExpression(node.expression);
            emitTokenWithComment(SyntaxKind.CloseParenToken, node.expression.end, writePunctuation, node);
            emitEmbeddedStatement(node, node.thenStatement);
            if (node.elseStatement) {
                writeLineOrSpace(node);
                emitTokenWithComment(SyntaxKind.ElseKeyword, node.thenStatement.end, writeKeyword, node);
                if (node.elseStatement.kind === SyntaxKind.IfStatement) {
                    writeSpace();
                    emit(node.elseStatement);
                }
                else {
                    emitEmbeddedStatement(node, node.elseStatement);
                }
            }
        }

        function emitWhileClause(node: WhileStatement | DoStatement, startPos: number) {
            const openParenPos = emitTokenWithComment(SyntaxKind.WhileKeyword, startPos, writeKeyword, node);
            writeSpace();
            emitTokenWithComment(SyntaxKind.OpenParenToken, openParenPos, writePunctuation, node);
            emitExpression(node.expression);
            emitTokenWithComment(SyntaxKind.CloseParenToken, node.expression.end, writePunctuation, node);
        }

        function emitDoStatement(node: DoStatement) {
            emitTokenWithComment(SyntaxKind.DoKeyword, node.pos, writeKeyword, node);
            emitEmbeddedStatement(node, node.statement);
            if (isBlock(node.statement)) {
                writeSpace();
            }
            else {
                writeLineOrSpace(node);
            }

            emitWhileClause(node, node.statement.end);
            writePunctuation(";");
        }

        function emitWhileStatement(node: WhileStatement) {
            emitWhileClause(node, node.pos);
            emitEmbeddedStatement(node, node.statement);
        }

        function emitForStatement(node: ForStatement) {
            const openParenPos = emitTokenWithComment(SyntaxKind.ForKeyword, node.pos, writeKeyword, node);
            writeSpace();
            let pos = emitTokenWithComment(SyntaxKind.OpenParenToken, openParenPos, writePunctuation, /*contextNode*/ node);
            emitForBinding(node.initializer);
            pos = emitTokenWithComment(SyntaxKind.SemicolonToken, node.initializer ? node.initializer.end : pos, writePunctuation, node);
            emitExpressionWithLeadingSpace(node.condition);
            pos = emitTokenWithComment(SyntaxKind.SemicolonToken, node.condition ? node.condition.end : pos, writePunctuation, node);
            emitExpressionWithLeadingSpace(node.incrementor);
            emitTokenWithComment(SyntaxKind.CloseParenToken, node.incrementor ? node.incrementor.end : pos, writePunctuation, node);
            emitEmbeddedStatement(node, node.statement);
        }

        function emitForInStatement(node: ForInStatement) {
            const openParenPos = emitTokenWithComment(SyntaxKind.ForKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emitTokenWithComment(SyntaxKind.OpenParenToken, openParenPos, writePunctuation, node);
            emitForBinding(node.initializer);
            writeSpace();
            emitTokenWithComment(SyntaxKind.InKeyword, node.initializer.end, writeKeyword, node);
            writeSpace();
            emitExpression(node.expression);
            emitTokenWithComment(SyntaxKind.CloseParenToken, node.expression.end, writePunctuation, node);
            emitEmbeddedStatement(node, node.statement);
        }

        function emitForOfStatement(node: ForOfStatement) {
            const openParenPos = emitTokenWithComment(SyntaxKind.ForKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emitWithTrailingSpace(node.awaitModifier);
            emitTokenWithComment(SyntaxKind.OpenParenToken, openParenPos, writePunctuation, node);
            emitForBinding(node.initializer);
            writeSpace();
            emitTokenWithComment(SyntaxKind.OfKeyword, node.initializer.end, writeKeyword, node);
            writeSpace();
            emitExpression(node.expression);
            emitTokenWithComment(SyntaxKind.CloseParenToken, node.expression.end, writePunctuation, node);
            emitEmbeddedStatement(node, node.statement);
        }

        function emitForBinding(node: VariableDeclarationList | Expression | undefined) {
            if (node !== undefined) {
                if (node.kind === SyntaxKind.VariableDeclarationList) {
                    emit(node);
                }
                else {
                    emitExpression(node);
                }
            }
        }

        function emitContinueStatement(node: ContinueStatement) {
            emitTokenWithComment(SyntaxKind.ContinueKeyword, node.pos, writeKeyword, node);
            emitWithLeadingSpace(node.label);
            writeTrailingSemicolon();
        }

        function emitBreakStatement(node: BreakStatement) {
            emitTokenWithComment(SyntaxKind.BreakKeyword, node.pos, writeKeyword, node);
            emitWithLeadingSpace(node.label);
            writeTrailingSemicolon();
        }

        function emitTokenWithComment(token: SyntaxKind, pos: number, writer: (s: string) => void, contextNode: Node, indentLeading?: boolean) {
            const node = getParseTreeNode(contextNode);
            const isSimilarNode = node && node.kind === contextNode.kind;
            const startPos = pos;
            if (isSimilarNode) {
                pos = skipTrivia(currentSourceFile!.text, pos);
            }
            if (emitLeadingCommentsOfPosition && isSimilarNode && contextNode.pos !== startPos) {
                const needsIndent = indentLeading && !positionsAreOnSameLine(startPos, pos, currentSourceFile!);
                if (needsIndent) {
                    increaseIndent();
                }
                emitLeadingCommentsOfPosition(startPos);
                if (needsIndent) {
                    decreaseIndent();
                }
            }
            pos = writeTokenText(token, writer, pos);
            if (emitTrailingCommentsOfPosition && isSimilarNode && contextNode.end !== pos) {
                emitTrailingCommentsOfPosition(pos, /*prefixSpace*/ true);
            }
            return pos;
        }

        function emitReturnStatement(node: ReturnStatement) {
            emitTokenWithComment(SyntaxKind.ReturnKeyword, node.pos, writeKeyword, /*contextNode*/ node);
            emitExpressionWithLeadingSpace(node.expression);
            writeTrailingSemicolon();
        }

        function emitWithStatement(node: WithStatement) {
            const openParenPos = emitTokenWithComment(SyntaxKind.WithKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emitTokenWithComment(SyntaxKind.OpenParenToken, openParenPos, writePunctuation, node);
            emitExpression(node.expression);
            emitTokenWithComment(SyntaxKind.CloseParenToken, node.expression.end, writePunctuation, node);
            emitEmbeddedStatement(node, node.statement);
        }

        function emitSwitchStatement(node: SwitchStatement) {
            const openParenPos = emitTokenWithComment(SyntaxKind.SwitchKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emitTokenWithComment(SyntaxKind.OpenParenToken, openParenPos, writePunctuation, node);
            emitExpression(node.expression);
            emitTokenWithComment(SyntaxKind.CloseParenToken, node.expression.end, writePunctuation, node);
            writeSpace();
            emit(node.caseBlock);
        }

        function emitLabeledStatement(node: LabeledStatement) {
            emit(node.label);
            emitTokenWithComment(SyntaxKind.ColonToken, node.label.end, writePunctuation, node);
            writeSpace();
            emit(node.statement);
        }

        function emitThrowStatement(node: ThrowStatement) {
            emitTokenWithComment(SyntaxKind.ThrowKeyword, node.pos, writeKeyword, node);
            emitExpressionWithLeadingSpace(node.expression);
            writeTrailingSemicolon();
        }

        function emitTryStatement(node: TryStatement) {
            emitTokenWithComment(SyntaxKind.TryKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emit(node.tryBlock);
            if (node.catchClause) {
                writeLineOrSpace(node);
                emit(node.catchClause);
            }
            if (node.finallyBlock) {
                writeLineOrSpace(node);
                emitTokenWithComment(SyntaxKind.FinallyKeyword, (node.catchClause || node.tryBlock).end, writeKeyword, node);
                writeSpace();
                emit(node.finallyBlock);
            }
        }

        function emitDebuggerStatement(node: DebuggerStatement) {
            writeToken(SyntaxKind.DebuggerKeyword, node.pos, writeKeyword);
            writeTrailingSemicolon();
        }

        //
        // Declarations
        //

        function emitVariableDeclaration(node: VariableDeclaration) {
            emit(node.name);
            emitTypeAnnotation(node.type);
            emitInitializer(node.initializer, node.type ? node.type.end : node.name.end, node);
        }

        function emitVariableDeclarationList(node: VariableDeclarationList) {
            writeKeyword(isLet(node) ? "let" : isVarConst(node) ? "const" : "var");
            writeSpace();
            emitList(node, node.declarations, ListFormat.VariableDeclarationList);
        }

        function emitFunctionDeclaration(node: FunctionDeclaration) {
            emitFunctionDeclarationOrExpression(node);
        }

        function emitFunctionDeclarationOrExpression(node: FunctionDeclaration | FunctionExpression) {
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            writeKeyword("function");
            emit(node.asteriskToken);
            writeSpace();
            emitIdentifierName(node.name!); // TODO: GH#18217
            emitSignatureAndBody(node, emitSignatureHead);
        }

        function emitBlockCallback(_hint: EmitHint, body: Node): void {
            emitBlockFunctionBody(<Block>body);
        }

        function emitSignatureAndBody(node: FunctionLikeDeclaration, emitSignatureHead: (node: SignatureDeclaration) => void) {
            const body = node.body;
            if (body) {
                if (isBlock(body)) {
                    const indentedFlag = getEmitFlags(node) & EmitFlags.Indented;
                    if (indentedFlag) {
                        increaseIndent();
                    }

                    pushNameGenerationScope(node);
                    forEach(node.parameters, generateNames);
                    generateNames(node.body);

                    emitSignatureHead(node);
                    if (onEmitNode) {
                        onEmitNode(EmitHint.Unspecified, body, emitBlockCallback);
                    }
                    else {
                        emitBlockFunctionBody(body);
                    }
                    popNameGenerationScope(node);

                    if (indentedFlag) {
                        decreaseIndent();
                    }
                }
                else {
                    emitSignatureHead(node);
                    writeSpace();
                    emitExpression(body);
                }
            }
            else {
                emitSignatureHead(node);
                writeTrailingSemicolon();
            }

        }

        function emitSignatureHead(node: FunctionDeclaration | FunctionExpression | MethodDeclaration | AccessorDeclaration | ConstructorDeclaration) {
            emitTypeParameters(node, node.typeParameters);
            emitParameters(node, node.parameters);
            emitTypeAnnotation(node.type);
        }

        function shouldEmitBlockFunctionBodyOnSingleLine(body: Block) {
            // We must emit a function body as a single-line body in the following case:
            // * The body has NodeEmitFlags.SingleLine specified.

            // We must emit a function body as a multi-line body in the following cases:
            // * The body is explicitly marked as multi-line.
            // * A non-synthesized body's start and end position are on different lines.
            // * Any statement in the body starts on a new line.

            if (getEmitFlags(body) & EmitFlags.SingleLine) {
                return true;
            }

            if (body.multiLine) {
                return false;
            }

            if (!nodeIsSynthesized(body) && !rangeIsOnSingleLine(body, currentSourceFile!)) {
                return false;
            }

            if (shouldWriteLeadingLineTerminator(body, body.statements, ListFormat.PreserveLines)
                || shouldWriteClosingLineTerminator(body, body.statements, ListFormat.PreserveLines)) {
                return false;
            }

            let previousStatement: Statement | undefined;
            for (const statement of body.statements) {
                if (shouldWriteSeparatingLineTerminator(previousStatement, statement, ListFormat.PreserveLines)) {
                    return false;
                }

                previousStatement = statement;
            }

            return true;
        }

        function emitBlockFunctionBody(body: Block) {
            writeSpace();
            writePunctuation("{");
            increaseIndent();

            const emitBlockFunctionBody = shouldEmitBlockFunctionBodyOnSingleLine(body)
                ? emitBlockFunctionBodyOnSingleLine
                : emitBlockFunctionBodyWorker;

            if (emitBodyWithDetachedComments) {
                emitBodyWithDetachedComments(body, body.statements, emitBlockFunctionBody);
            }
            else {
                emitBlockFunctionBody(body);
            }

            decreaseIndent();
            writeToken(SyntaxKind.CloseBraceToken, body.statements.end, writePunctuation, body);
        }

        function emitBlockFunctionBodyOnSingleLine(body: Block) {
            emitBlockFunctionBodyWorker(body, /*emitBlockFunctionBodyOnSingleLine*/ true);
        }

        function emitBlockFunctionBodyWorker(body: Block, emitBlockFunctionBodyOnSingleLine?: boolean) {
            // Emit all the prologue directives (like "use strict").
            const statementOffset = emitPrologueDirectives(body.statements, /*startWithNewLine*/ true);
            const pos = writer.getTextPos();
            emitHelpers(body);
            if (statementOffset === 0 && pos === writer.getTextPos() && emitBlockFunctionBodyOnSingleLine) {
                decreaseIndent();
                emitList(body, body.statements, ListFormat.SingleLineFunctionBodyStatements);
                increaseIndent();
            }
            else {
                emitList(body, body.statements, ListFormat.MultiLineFunctionBodyStatements, statementOffset);
            }
        }

        function emitClassDeclaration(node: ClassDeclaration) {
            emitClassDeclarationOrExpression(node);
        }

        function emitClassDeclarationOrExpression(node: ClassDeclaration | ClassExpression) {
            forEach(node.members, generateMemberNames);

            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            writeKeyword("class");
            if (node.name) {
                writeSpace();
                emitIdentifierName(node.name);
            }

            const indentedFlag = getEmitFlags(node) & EmitFlags.Indented;
            if (indentedFlag) {
                increaseIndent();
            }

            emitTypeParameters(node, node.typeParameters);
            emitList(node, node.heritageClauses, ListFormat.ClassHeritageClauses);

            writeSpace();
            writePunctuation("{");
            emitList(node, node.members, ListFormat.ClassMembers);
            writePunctuation("}");

            if (indentedFlag) {
                decreaseIndent();
            }
        }

        function emitInterfaceDeclaration(node: InterfaceDeclaration) {
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            writeKeyword("interface");
            writeSpace();
            emit(node.name);
            emitTypeParameters(node, node.typeParameters);
            emitList(node, node.heritageClauses, ListFormat.HeritageClauses);
            writeSpace();
            writePunctuation("{");
            emitList(node, node.members, ListFormat.InterfaceMembers);
            writePunctuation("}");
        }

        function emitTypeAliasDeclaration(node: TypeAliasDeclaration) {
            emitDecorators(node, node.decorators);
            emitModifiers(node, node.modifiers);
            writeKeyword("type");
            writeSpace();
            emit(node.name);
            emitTypeParameters(node, node.typeParameters);
            writeSpace();
            writePunctuation("=");
            writeSpace();
            emit(node.type);
            writeTrailingSemicolon();
        }

        function emitEnumDeclaration(node: EnumDeclaration) {
            emitModifiers(node, node.modifiers);
            writeKeyword("enum");
            writeSpace();
            emit(node.name);

            writeSpace();
            writePunctuation("{");
            emitList(node, node.members, ListFormat.EnumMembers);
            writePunctuation("}");
        }

        function emitModuleDeclaration(node: ModuleDeclaration) {
            emitModifiers(node, node.modifiers);
            if (~node.flags & NodeFlags.GlobalAugmentation) {
                writeKeyword(node.flags & NodeFlags.Namespace ? "namespace" : "module");
                writeSpace();
            }
            emit(node.name);

            let body = node.body;
            if (!body) return writeTrailingSemicolon();
            while (body.kind === SyntaxKind.ModuleDeclaration) {
                writePunctuation(".");
                emit((<ModuleDeclaration>body).name);
                body = (<ModuleDeclaration>body).body!;
            }

            writeSpace();
            emit(body);
        }

        function emitModuleBlock(node: ModuleBlock) {
            pushNameGenerationScope(node);
            forEach(node.statements, generateNames);
            emitBlockStatements(node, /*forceSingleLine*/ isEmptyBlock(node));
            popNameGenerationScope(node);
        }

        function emitCaseBlock(node: CaseBlock) {
            emitTokenWithComment(SyntaxKind.OpenBraceToken, node.pos, writePunctuation, node);
            emitList(node, node.clauses, ListFormat.CaseBlockClauses);
            emitTokenWithComment(SyntaxKind.CloseBraceToken, node.clauses.end, writePunctuation, node, /*indentLeading*/ true);
        }

        function emitImportEqualsDeclaration(node: ImportEqualsDeclaration) {
            emitModifiers(node, node.modifiers);
            emitTokenWithComment(SyntaxKind.ImportKeyword, node.modifiers ? node.modifiers.end : node.pos, writeKeyword, node);
            writeSpace();
            emit(node.name);
            writeSpace();
            emitTokenWithComment(SyntaxKind.EqualsToken, node.name.end, writePunctuation, node);
            writeSpace();
            emitModuleReference(node.moduleReference);
            writeTrailingSemicolon();
        }

        function emitModuleReference(node: ModuleReference) {
            if (node.kind === SyntaxKind.Identifier) {
                emitExpression(node);
            }
            else {
                emit(node);
            }
        }

        function emitImportDeclaration(node: ImportDeclaration) {
            emitModifiers(node, node.modifiers);
            emitTokenWithComment(SyntaxKind.ImportKeyword, node.modifiers ? node.modifiers.end : node.pos, writeKeyword, node);
            writeSpace();
            if (node.importClause) {
                emit(node.importClause);
                writeSpace();
                emitTokenWithComment(SyntaxKind.FromKeyword, node.importClause.end, writeKeyword, node);
                writeSpace();
            }
            emitExpression(node.moduleSpecifier);
            writeTrailingSemicolon();
        }

        function emitImportClause(node: ImportClause) {
            emit(node.name);
            if (node.name && node.namedBindings) {
                emitTokenWithComment(SyntaxKind.CommaToken, node.name.end, writePunctuation, node);
                writeSpace();
            }
            emit(node.namedBindings);
        }

        function emitNamespaceImport(node: NamespaceImport) {
            const asPos = emitTokenWithComment(SyntaxKind.AsteriskToken, node.pos, writePunctuation, node);
            writeSpace();
            emitTokenWithComment(SyntaxKind.AsKeyword, asPos, writeKeyword, node);
            writeSpace();
            emit(node.name);
        }

        function emitNamedImports(node: NamedImports) {
            emitNamedImportsOrExports(node);
        }

        function emitImportSpecifier(node: ImportSpecifier) {
            emitImportOrExportSpecifier(node);
        }

        function emitExportAssignment(node: ExportAssignment) {
            const nextPos = emitTokenWithComment(SyntaxKind.ExportKeyword, node.pos, writeKeyword, node);
            writeSpace();
            if (node.isExportEquals) {
                emitTokenWithComment(SyntaxKind.EqualsToken, nextPos, writeOperator, node);
            }
            else {
                emitTokenWithComment(SyntaxKind.DefaultKeyword, nextPos, writeKeyword, node);
            }
            writeSpace();
            emitExpression(node.expression);
            writeTrailingSemicolon();
        }

        function emitExportDeclaration(node: ExportDeclaration) {
            let nextPos = emitTokenWithComment(SyntaxKind.ExportKeyword, node.pos, writeKeyword, node);
            writeSpace();
            if (node.exportClause) {
                emit(node.exportClause);
            }
            else {
                nextPos = emitTokenWithComment(SyntaxKind.AsteriskToken, nextPos, writePunctuation, node);
            }
            if (node.moduleSpecifier) {
                writeSpace();
                const fromPos = node.exportClause ? node.exportClause.end : nextPos;
                emitTokenWithComment(SyntaxKind.FromKeyword, fromPos, writeKeyword, node);
                writeSpace();
                emitExpression(node.moduleSpecifier);
            }
            writeTrailingSemicolon();
        }

        function emitNamespaceExportDeclaration(node: NamespaceExportDeclaration) {
            let nextPos = emitTokenWithComment(SyntaxKind.ExportKeyword, node.pos, writeKeyword, node);
            writeSpace();
            nextPos = emitTokenWithComment(SyntaxKind.AsKeyword, nextPos, writeKeyword, node);
            writeSpace();
            nextPos = emitTokenWithComment(SyntaxKind.NamespaceKeyword, nextPos, writeKeyword, node);
            writeSpace();
            emit(node.name);
            writeTrailingSemicolon();
        }

        function emitNamedExports(node: NamedExports) {
            emitNamedImportsOrExports(node);
        }

        function emitExportSpecifier(node: ExportSpecifier) {
            emitImportOrExportSpecifier(node);
        }

        function emitNamedImportsOrExports(node: NamedImportsOrExports) {
            writePunctuation("{");
            emitList(node, node.elements, ListFormat.NamedImportsOrExportsElements);
            writePunctuation("}");
        }

        function emitImportOrExportSpecifier(node: ImportOrExportSpecifier) {
            if (node.propertyName) {
                emit(node.propertyName);
                writeSpace();
                emitTokenWithComment(SyntaxKind.AsKeyword, node.propertyName.end, writeKeyword, node);
                writeSpace();
            }

            emit(node.name);
        }

        //
        // Module references
        //

        function emitExternalModuleReference(node: ExternalModuleReference) {
            writeKeyword("require");
            writePunctuation("(");
            emitExpression(node.expression);
            writePunctuation(")");
        }

        //
        // JSX
        //

        function emitJsxElement(node: JsxElement) {
            emit(node.openingElement);
            emitList(node, node.children, ListFormat.JsxElementOrFragmentChildren);
            emit(node.closingElement);
        }

        function emitJsxSelfClosingElement(node: JsxSelfClosingElement) {
            writePunctuation("<");
            emitJsxTagName(node.tagName);
            emitTypeArguments(node, node.typeArguments);
            writeSpace();
            emit(node.attributes);
            writePunctuation("/>");
        }

        function emitJsxFragment(node: JsxFragment) {
            emit(node.openingFragment);
            emitList(node, node.children, ListFormat.JsxElementOrFragmentChildren);
            emit(node.closingFragment);
        }

        function emitJsxOpeningElementOrFragment(node: JsxOpeningElement | JsxOpeningFragment) {
            writePunctuation("<");

            if (isJsxOpeningElement(node)) {
                emitJsxTagName(node.tagName);
                emitTypeArguments(node, node.typeArguments);
                if (node.attributes.properties && node.attributes.properties.length > 0) {
                    writeSpace();
                }
                emit(node.attributes);
            }

            writePunctuation(">");
        }

        function emitJsxText(node: JsxText) {
            writer.writeLiteral(getTextOfNode(node, /*includeTrivia*/ true));
        }

        function emitJsxClosingElementOrFragment(node: JsxClosingElement | JsxClosingFragment) {
            writePunctuation("</");
            if (isJsxClosingElement(node)) {
                emitJsxTagName(node.tagName);
            }
            writePunctuation(">");
        }

        function emitJsxAttributes(node: JsxAttributes) {
            emitList(node, node.properties, ListFormat.JsxElementAttributes);
        }

        function emitJsxAttribute(node: JsxAttribute) {
            emit(node.name);
            emitNodeWithPrefix("=", writePunctuation, node.initializer!, emit); // TODO: GH#18217
        }

        function emitJsxSpreadAttribute(node: JsxSpreadAttribute) {
            writePunctuation("{...");
            emitExpression(node.expression);
            writePunctuation("}");
        }

        function emitJsxExpression(node: JsxExpression) {
            if (node.expression) {
                writePunctuation("{");
                emit(node.dotDotDotToken);
                emitExpression(node.expression);
                writePunctuation("}");
            }
        }

        function emitJsxTagName(node: JsxTagNameExpression) {
            if (node.kind === SyntaxKind.Identifier) {
                emitExpression(node);
            }
            else {
                emit(node);
            }
        }

        //
        // Clauses
        //

        function emitCaseClause(node: CaseClause) {
            emitTokenWithComment(SyntaxKind.CaseKeyword, node.pos, writeKeyword, node);
            writeSpace();
            emitExpression(node.expression);

            emitCaseOrDefaultClauseRest(node, node.statements, node.expression.end);
        }

        function emitDefaultClause(node: DefaultClause) {
            const pos = emitTokenWithComment(SyntaxKind.DefaultKeyword, node.pos, writeKeyword, node);
            emitCaseOrDefaultClauseRest(node, node.statements, pos);
        }

        function emitCaseOrDefaultClauseRest(parentNode: Node, statements: NodeArray<Statement>, colonPos: number) {
            const emitAsSingleStatement =
                statements.length === 1 &&
                (
                    // treat synthesized nodes as located on the same line for emit purposes
                    nodeIsSynthesized(parentNode) ||
                    nodeIsSynthesized(statements[0]) ||
                    rangeStartPositionsAreOnSameLine(parentNode, statements[0], currentSourceFile!)
                );

            let format = ListFormat.CaseOrDefaultClauseStatements;
            if (emitAsSingleStatement) {
                writeToken(SyntaxKind.ColonToken, colonPos, writePunctuation, parentNode);
                writeSpace();
                format &= ~(ListFormat.MultiLine | ListFormat.Indented);
            }
            else {
                emitTokenWithComment(SyntaxKind.ColonToken, colonPos, writePunctuation, parentNode);
            }
            emitList(parentNode, statements, format);
        }

        function emitHeritageClause(node: HeritageClause) {
            writeSpace();
            writeTokenText(node.token, writeKeyword);
            writeSpace();
            emitList(node, node.types, ListFormat.HeritageClauseTypes);
        }

        function emitCatchClause(node: CatchClause) {
            const openParenPos = emitTokenWithComment(SyntaxKind.CatchKeyword, node.pos, writeKeyword, node);
            writeSpace();
            if (node.variableDeclaration) {
                emitTokenWithComment(SyntaxKind.OpenParenToken, openParenPos, writePunctuation, node);
                emit(node.variableDeclaration);
                emitTokenWithComment(SyntaxKind.CloseParenToken, node.variableDeclaration.end, writePunctuation, node);
                writeSpace();
            }
            emit(node.block);
        }

        //
        // Property assignments
        //

        function emitPropertyAssignment(node: PropertyAssignment) {
            emit(node.name);
            writePunctuation(":");
            writeSpace();
            // This is to ensure that we emit comment in the following case:
            //      For example:
            //          obj = {
            //              id: /*comment1*/ ()=>void
            //          }
            // "comment1" is not considered to be leading comment for node.initializer
            // but rather a trailing comment on the previous node.
            const initializer = node.initializer;
            if (emitTrailingCommentsOfPosition && (getEmitFlags(initializer) & EmitFlags.NoLeadingComments) === 0) {
                const commentRange = getCommentRange(initializer);
                emitTrailingCommentsOfPosition(commentRange.pos);
            }
            emitExpression(initializer);
        }

        function emitShorthandPropertyAssignment(node: ShorthandPropertyAssignment) {
            emit(node.name);
            if (node.objectAssignmentInitializer) {
                writeSpace();
                writePunctuation("=");
                writeSpace();
                emitExpression(node.objectAssignmentInitializer);
            }
        }

        function emitSpreadAssignment(node: SpreadAssignment) {
            if (node.expression) {
                emitTokenWithComment(SyntaxKind.DotDotDotToken, node.pos, writePunctuation, node);
                emitExpression(node.expression);
            }
        }

        //
        // Enum
        //

        function emitEnumMember(node: EnumMember) {
            emit(node.name);
            emitInitializer(node.initializer, node.name.end, node);
        }

        //
        // JSDoc
        //
        function emitJSDoc(node: JSDoc) {
            write("/**");
            if (node.comment) {
                const lines = node.comment.split(/\r\n?|\n/g);
                for (const line of lines) {
                    writeLine();
                    writeSpace();
                    writePunctuation("*");
                    writeSpace();
                    write(line);
                }
            }
            if (node.tags) {
                if (node.tags.length === 1 && node.tags[0].kind === SyntaxKind.JSDocTypeTag && !node.comment) {
                    writeSpace();
                    emit(node.tags[0]);
                }
                else {
                    emitList(node, node.tags, ListFormat.JSDocComment);
                }
            }
            writeSpace();
            write("*/");
        }

        function emitJSDocSimpleTypedTag(tag: JSDocTypeTag | JSDocThisTag | JSDocEnumTag | JSDocReturnTag) {
            emitJSDocTagName(tag.tagName);
            emitJSDocTypeExpression(tag.typeExpression);
            emitJSDocComment(tag.comment);
        }

        function emitJSDocAugmentsTag(tag: JSDocAugmentsTag) {
            emitJSDocTagName(tag.tagName);
            writeSpace();
            writePunctuation("{");
            emit(tag.class);
            writePunctuation("}");
            emitJSDocComment(tag.comment);
        }

        function emitJSDocTemplateTag(tag: JSDocTemplateTag) {
            emitJSDocTagName(tag.tagName);
            emitJSDocTypeExpression(tag.constraint);
            writeSpace();
            emitList(tag, tag.typeParameters, ListFormat.CommaListElements);
            emitJSDocComment(tag.comment);
        }

        function emitJSDocTypedefTag(tag: JSDocTypedefTag) {
            emitJSDocTagName(tag.tagName);
            if (tag.typeExpression) {
                if (tag.typeExpression.kind === SyntaxKind.JSDocTypeExpression) {
                    emitJSDocTypeExpression(tag.typeExpression);
                }
                else {
                    writeSpace();
                    writePunctuation("{");
                    write("Object");
                    if (tag.typeExpression.isArrayType) {
                        writePunctuation("[");
                        writePunctuation("]");
                    }
                    writePunctuation("}");
                }
            }
            if (tag.fullName) {
                writeSpace();
                emit(tag.fullName);
            }
            emitJSDocComment(tag.comment);
            if (tag.typeExpression && tag.typeExpression.kind === SyntaxKind.JSDocTypeLiteral) {
                emitJSDocTypeLiteral(tag.typeExpression);
            }
        }

        function emitJSDocCallbackTag(tag: JSDocCallbackTag) {
            emitJSDocTagName(tag.tagName);
            if (tag.name) {
                writeSpace();
                emit(tag.name);
            }
            emitJSDocComment(tag.comment);
            emitJSDocSignature(tag.typeExpression);
        }

        function emitJSDocSimpleTag(tag: JSDocTag) {
            emitJSDocTagName(tag.tagName);
            emitJSDocComment(tag.comment);
        }

        function emitJSDocTypeLiteral(lit: JSDocTypeLiteral) {
            emitList(lit, createNodeArray(lit.jsDocPropertyTags), ListFormat.JSDocComment);
        }

        function emitJSDocSignature(sig: JSDocSignature) {
            if (sig.typeParameters) {
                emitList(sig, createNodeArray(sig.typeParameters), ListFormat.JSDocComment);
            }
            if (sig.parameters) {
                emitList(sig, createNodeArray(sig.parameters), ListFormat.JSDocComment);
            }
            if (sig.type) {
                writeLine();
                writeSpace();
                writePunctuation("*");
                writeSpace();
                emit(sig.type);
            }
        }

        function emitJSDocPropertyLikeTag(param: JSDocPropertyLikeTag) {
            emitJSDocTagName(param.tagName);
            emitJSDocTypeExpression(param.typeExpression);
            writeSpace();
            if (param.isBracketed) {
                writePunctuation("[");
            }
            emit(param.name);
            if (param.isBracketed) {
                writePunctuation("]");
            }
            emitJSDocComment(param.comment);
        }

        function emitJSDocTagName(tagName: Identifier) {
            writePunctuation("@");
            emit(tagName);
        }

        function emitJSDocComment(comment: string | undefined) {
            if (comment) {
                writeSpace();
                write(comment);
            }
        }

        function emitJSDocTypeExpression(typeExpression: JSDocTypeExpression | undefined) {
            if (typeExpression) {
                writeSpace();
                writePunctuation("{");
                emit(typeExpression.type);
                writePunctuation("}");
            }
        }

        //
        // Top-level nodes
        //

        function emitSourceFile(node: SourceFile) {
            writeLine();
            const statements = node.statements;
            if (emitBodyWithDetachedComments) {
                // Emit detached comment if there are no prologue directives or if the first node is synthesized.
                // The synthesized node will have no leading comment so some comments may be missed.
                const shouldEmitDetachedComment = statements.length === 0 ||
                    !isPrologueDirective(statements[0]) ||
                    nodeIsSynthesized(statements[0]);
                if (shouldEmitDetachedComment) {
                    emitBodyWithDetachedComments(node, statements, emitSourceFileWorker);
                    return;
                }
            }
            emitSourceFileWorker(node);
        }

        function emitSyntheticTripleSlashReferencesIfNeeded(node: Bundle) {
            emitTripleSlashDirectives(!!node.hasNoDefaultLib, node.syntheticFileReferences || [], node.syntheticTypeReferences || [], node.syntheticLibReferences || []);
        }

        function emitTripleSlashDirectivesIfNeeded(node: SourceFile) {
            if (node.isDeclarationFile) emitTripleSlashDirectives(node.hasNoDefaultLib, node.referencedFiles, node.typeReferenceDirectives, node.libReferenceDirectives);
        }

        function emitTripleSlashDirectives(hasNoDefaultLib: boolean, files: ReadonlyArray<FileReference>, types: ReadonlyArray<FileReference>, libs: ReadonlyArray<FileReference>) {
            if (hasNoDefaultLib) {
                writeComment(`/// <reference no-default-lib="true"/>`);
                writeLine();
            }
            if (currentSourceFile && currentSourceFile.moduleName) {
                writeComment(`/// <amd-module name="${currentSourceFile.moduleName}" />`);
                writeLine();
            }
            if (currentSourceFile && currentSourceFile.amdDependencies) {
                for (const dep of currentSourceFile.amdDependencies) {
                    if (dep.name) {
                        writeComment(`/// <amd-dependency name="${dep.name}" path="${dep.path}" />`);
                    }
                    else {
                        writeComment(`/// <amd-dependency path="${dep.path}" />`);
                    }
                    writeLine();
                }
            }
            for (const directive of files) {
                writeComment(`/// <reference path="${directive.fileName}" />`);
                writeLine();
            }
            for (const directive of types) {
                writeComment(`/// <reference types="${directive.fileName}" />`);
                writeLine();
            }
            for (const directive of libs) {
                writeComment(`/// <reference lib="${directive.fileName}" />`);
                writeLine();
            }
        }

        function emitSourceFileWorker(node: SourceFile) {
            const statements = node.statements;
            pushNameGenerationScope(node);
            forEach(node.statements, generateNames);
            emitHelpers(node);
            const index = findIndex(statements, statement => !isPrologueDirective(statement));
            emitTripleSlashDirectivesIfNeeded(node);
            emitList(node, statements, ListFormat.MultiLine, index === -1 ? statements.length : index);
            popNameGenerationScope(node);
        }

        // Transformation nodes

        function emitPartiallyEmittedExpression(node: PartiallyEmittedExpression) {
            emitExpression(node.expression);
        }

        function emitCommaList(node: CommaListExpression) {
            emitExpressionList(node, node.elements, ListFormat.CommaListElements);
        }

        /**
         * Emits any prologue directives at the start of a Statement list, returning the
         * number of prologue directives written to the output.
         */
        function emitPrologueDirectives(statements: ReadonlyArray<Node>, startWithNewLine?: boolean, seenPrologueDirectives?: Map<true>): number {
            for (let i = 0; i < statements.length; i++) {
                const statement = statements[i];
                if (isPrologueDirective(statement)) {
                    const shouldEmitPrologueDirective = seenPrologueDirectives ? !seenPrologueDirectives.has(statement.expression.text) : true;
                    if (shouldEmitPrologueDirective) {
                        if (startWithNewLine || i > 0) {
                            writeLine();
                        }
                        emit(statement);
                        if (seenPrologueDirectives) {
                            seenPrologueDirectives.set(statement.expression.text, true);
                        }
                    }
                }
                else {
                    // return index of the first non prologue directive
                    return i;
                }
            }

            return statements.length;
        }

        function emitPrologueDirectivesIfNeeded(sourceFileOrBundle: Bundle | SourceFile) {
            if (isSourceFile(sourceFileOrBundle)) {
                setSourceFile(sourceFileOrBundle);
                emitPrologueDirectives(sourceFileOrBundle.statements);
            }
            else {
                const seenPrologueDirectives = createMap<true>();
                for (const sourceFile of sourceFileOrBundle.sourceFiles) {
                    setSourceFile(sourceFile);
                    emitPrologueDirectives(sourceFile.statements, /*startWithNewLine*/ true, seenPrologueDirectives);
                }
                setSourceFile(undefined);
            }
        }

        function emitShebangIfNeeded(sourceFileOrBundle: Bundle | SourceFile) {
            if (isSourceFile(sourceFileOrBundle)) {
                const shebang = getShebang(sourceFileOrBundle.text);
                if (shebang) {
                    writeComment(shebang);
                    writeLine();
                    return true;
                }
            }
            else {
                for (const sourceFile of sourceFileOrBundle.sourceFiles) {
                    // Emit only the first encountered shebang
                    if (emitShebangIfNeeded(sourceFile)) {
                        break;
                    }
                }
            }
        }

        //
        // Helpers
        //

        function emitNodeWithWriter(node: Node | undefined, writer: typeof write) {
            if (!node) return;
            const savedWrite = write;
            write = writer;
            emit(node);
            write = savedWrite;
        }

        function emitModifiers(node: Node, modifiers: NodeArray<Modifier> | undefined) {
            if (modifiers && modifiers.length) {
                emitList(node, modifiers, ListFormat.Modifiers);
                writeSpace();
            }
        }

        function emitTypeAnnotation(node: TypeNode | undefined) {
            if (node) {
                writePunctuation(":");
                writeSpace();
                emit(node);
            }
        }

        function emitInitializer(node: Expression | undefined, equalCommentStartPos: number, container: Node) {
            if (node) {
                writeSpace();
                emitTokenWithComment(SyntaxKind.EqualsToken, equalCommentStartPos, writeOperator, container);
                writeSpace();
                emitExpression(node);
            }
        }

        function emitNodeWithPrefix(prefix: string, prefixWriter: (s: string) => void, node: Node, emit: (node: Node) => void) {
            if (node) {
                prefixWriter(prefix);
                emit(node);
            }
        }

        function emitWithLeadingSpace(node: Node | undefined) {
            if (node) {
                writeSpace();
                emit(node);
            }
        }

        function emitExpressionWithLeadingSpace(node: Expression | undefined) {
            if (node) {
                writeSpace();
                emitExpression(node);
            }
        }

        function emitWithTrailingSpace(node: Node | undefined) {
            if (node) {
                emit(node);
                writeSpace();
            }
        }

        function emitEmbeddedStatement(parent: Node, node: Statement) {
            if (isBlock(node) || getEmitFlags(parent) & EmitFlags.SingleLine) {
                writeSpace();
                emit(node);
            }
            else {
                writeLine();
                increaseIndent();
                if (isEmptyStatement(node)) {
                    const pipelinePhase = getPipelinePhase(PipelinePhase.Notification, node);
                    pipelinePhase(EmitHint.EmbeddedStatement, node);
                }
                else {
                    emit(node);
                }
                decreaseIndent();
            }
        }

        function emitDecorators(parentNode: Node, decorators: NodeArray<Decorator> | undefined) {
            emitList(parentNode, decorators, ListFormat.Decorators);
        }

        function emitTypeArguments(parentNode: Node, typeArguments: NodeArray<TypeNode> | undefined) {
            emitList(parentNode, typeArguments, ListFormat.TypeArguments);
        }

        function emitTypeParameters(parentNode: SignatureDeclaration | InterfaceDeclaration | TypeAliasDeclaration | ClassDeclaration | ClassExpression, typeParameters: NodeArray<TypeParameterDeclaration> | undefined) {
            if (isFunctionLike(parentNode) && parentNode.typeArguments) { // Quick info uses type arguments in place of type parameters on instantiated signatures
                return emitTypeArguments(parentNode, parentNode.typeArguments);
            }
            emitList(parentNode, typeParameters, ListFormat.TypeParameters);
        }

        function emitParameters(parentNode: Node, parameters: NodeArray<ParameterDeclaration>) {
            emitList(parentNode, parameters, ListFormat.Parameters);
        }

        function canEmitSimpleArrowHead(parentNode: FunctionTypeNode | ArrowFunction, parameters: NodeArray<ParameterDeclaration>) {
            const parameter = singleOrUndefined(parameters);
            return parameter
                && parameter.pos === parentNode.pos // may not have parsed tokens between parent and parameter
                && isArrowFunction(parentNode)      // only arrow functions may have simple arrow head
                && !parentNode.type                 // arrow function may not have return type annotation
                && !some(parentNode.decorators)     // parent may not have decorators
                && !some(parentNode.modifiers)      // parent may not have modifiers
                && !some(parentNode.typeParameters) // parent may not have type parameters
                && !some(parameter.decorators)      // parameter may not have decorators
                && !some(parameter.modifiers)       // parameter may not have modifiers
                && !parameter.dotDotDotToken        // parameter may not be rest
                && !parameter.questionToken         // parameter may not be optional
                && !parameter.type                  // parameter may not have a type annotation
                && !parameter.initializer           // parameter may not have an initializer
                && isIdentifier(parameter.name);    // parameter name must be identifier
        }

        function emitParametersForArrow(parentNode: FunctionTypeNode | ArrowFunction, parameters: NodeArray<ParameterDeclaration>) {
            if (canEmitSimpleArrowHead(parentNode, parameters)) {
                emitList(parentNode, parameters, ListFormat.Parameters & ~ListFormat.Parenthesis);
            }
            else {
                emitParameters(parentNode, parameters);
            }
        }

        function emitParametersForIndexSignature(parentNode: Node, parameters: NodeArray<ParameterDeclaration>) {
            emitList(parentNode, parameters, ListFormat.IndexSignatureParameters);
        }

        function emitList(parentNode: TextRange, children: NodeArray<Node> | undefined, format: ListFormat, start?: number, count?: number) {
            emitNodeList(emit, parentNode, children, format, start, count);
        }

        function emitExpressionList(parentNode: TextRange, children: NodeArray<Node> | undefined, format: ListFormat, start?: number, count?: number) {
            emitNodeList(emitExpression as (node: Node) => void, parentNode, children, format, start, count); // TODO: GH#18217
        }

        function writeDelimiter(format: ListFormat) {
            switch (format & ListFormat.DelimitersMask) {
                case ListFormat.None:
                    break;
                case ListFormat.CommaDelimited:
                    writePunctuation(",");
                    break;
                case ListFormat.BarDelimited:
                    writeSpace();
                    writePunctuation("|");
                    break;
                case ListFormat.AsteriskDelimited:
                    writeSpace();
                    writePunctuation("*");
                    writeSpace();
                    break;
                case ListFormat.AmpersandDelimited:
                    writeSpace();
                    writePunctuation("&");
                    break;
            }
        }

        function emitNodeList(emit: (node: Node) => void, parentNode: TextRange, children: NodeArray<Node> | undefined, format: ListFormat, start = 0, count = children ? children.length - start : 0) {
            const isUndefined = children === undefined;
            if (isUndefined && format & ListFormat.OptionalIfUndefined) {
                return;
            }

            const isEmpty = children === undefined || start >= children.length || count === 0;
            if (isEmpty && format & ListFormat.OptionalIfEmpty) {
                if (onBeforeEmitNodeArray) {
                    onBeforeEmitNodeArray(children);
                }
                if (onAfterEmitNodeArray) {
                    onAfterEmitNodeArray(children);
                }
                return;
            }

            if (format & ListFormat.BracketsMask) {
                writePunctuation(getOpeningBracket(format));
                if (isEmpty && !isUndefined) {
                    // TODO: GH#18217
                    emitTrailingCommentsOfPosition(children!.pos, /*prefixSpace*/ true); // Emit comments within empty bracketed lists
                }
            }

            if (onBeforeEmitNodeArray) {
                onBeforeEmitNodeArray(children);
            }

            if (isEmpty) {
                // Write a line terminator if the parent node was multi-line
                if (format & ListFormat.MultiLine) {
                    writeLine();
                }
                else if (format & ListFormat.SpaceBetweenBraces && !(format & ListFormat.NoSpaceIfEmpty)) {
                    writeSpace();
                }
            }
            else {
                // Write the opening line terminator or leading whitespace.
                const mayEmitInterveningComments = (format & ListFormat.NoInterveningComments) === 0;
                let shouldEmitInterveningComments = mayEmitInterveningComments;
                if (shouldWriteLeadingLineTerminator(parentNode, children!, format)) { // TODO: GH#18217
                    writeLine();
                    shouldEmitInterveningComments = false;
                }
                else if (format & ListFormat.SpaceBetweenBraces) {
                    writeSpace();
                }

                // Increase the indent, if requested.
                if (format & ListFormat.Indented) {
                    increaseIndent();
                }

                // Emit each child.
                let previousSibling: Node | undefined;
                let shouldDecreaseIndentAfterEmit = false;
                for (let i = 0; i < count; i++) {
                    const child = children![start + i];

                    // Write the delimiter if this is not the first node.
                    if (format & ListFormat.AsteriskDelimited) {
                        // always write JSDoc in the format "\n *"
                        writeLine();
                        writeDelimiter(format);
                    }
                    else if (previousSibling) {
                        // i.e
                        //      function commentedParameters(
                        //          /* Parameter a */
                        //          a
                        //          /* End of parameter a */ -> this comment isn't considered to be trailing comment of parameter "a" due to newline
                        //          ,
                        if (format & ListFormat.DelimitersMask && previousSibling.end !== parentNode.end) {
                            emitLeadingCommentsOfPosition(previousSibling.end);
                        }
                        writeDelimiter(format);

                        // Write either a line terminator or whitespace to separate the elements.
                        if (shouldWriteSeparatingLineTerminator(previousSibling, child, format)) {
                            // If a synthesized node in a single-line list starts on a new
                            // line, we should increase the indent.
                            if ((format & (ListFormat.LinesMask | ListFormat.Indented)) === ListFormat.SingleLine) {
                                increaseIndent();
                                shouldDecreaseIndentAfterEmit = true;
                            }

                            writeLine();
                            shouldEmitInterveningComments = false;
                        }
                        else if (previousSibling && format & ListFormat.SpaceBetweenSiblings) {
                            writeSpace();
                        }
                    }

                    // Emit this child.
                    if (shouldEmitInterveningComments) {
                        if (emitTrailingCommentsOfPosition) {
                            const commentRange = getCommentRange(child);
                            emitTrailingCommentsOfPosition(commentRange.pos);
                        }
                    }
                    else {
                        shouldEmitInterveningComments = mayEmitInterveningComments;
                    }

                    emit(child);

                    if (shouldDecreaseIndentAfterEmit) {
                        decreaseIndent();
                        shouldDecreaseIndentAfterEmit = false;
                    }

                    previousSibling = child;
                }

                // Write a trailing comma, if requested.
                const hasTrailingComma = (format & ListFormat.AllowTrailingComma) && children!.hasTrailingComma;
                if (format & ListFormat.CommaDelimited && hasTrailingComma) {
                    writePunctuation(",");
                }


                // Emit any trailing comment of the last element in the list
                // i.e
                //       var array = [...
                //          2
                //          /* end of element 2 */
                //       ];
                if (previousSibling && format & ListFormat.DelimitersMask && previousSibling.end !== parentNode.end && !(getEmitFlags(previousSibling) & EmitFlags.NoTrailingComments)) {
                    emitLeadingCommentsOfPosition(previousSibling.end);
                }

                // Decrease the indent, if requested.
                if (format & ListFormat.Indented) {
                    decreaseIndent();
                }

                // Write the closing line terminator or closing whitespace.
                if (shouldWriteClosingLineTerminator(parentNode, children!, format)) {
                    writeLine();
                }
                else if (format & ListFormat.SpaceBetweenBraces) {
                    writeSpace();
                }
            }

            if (onAfterEmitNodeArray) {
                onAfterEmitNodeArray(children);
            }

            if (format & ListFormat.BracketsMask) {
                if (isEmpty && !isUndefined) {
                    // TODO: GH#18217
                    emitLeadingCommentsOfPosition(children!.end); // Emit leading comments within empty lists
                }
                writePunctuation(getClosingBracket(format));
            }
        }

        // Writers

        function writeLiteral(s: string) {
            writer.writeLiteral(s);
        }

        function writeStringLiteral(s: string) {
            writer.writeStringLiteral(s);
        }

        function writeBase(s: string) {
            writer.write(s);
        }

        function writeSymbol(s: string, sym: Symbol) {
            writer.writeSymbol(s, sym);
        }

        function writePunctuation(s: string) {
            writer.writePunctuation(s);
        }

        function writeTrailingSemicolon() {
            writer.writeTrailingSemicolon(";");
        }

        function writeKeyword(s: string) {
            writer.writeKeyword(s);
        }

        function writeOperator(s: string) {
            writer.writeOperator(s);
        }

        function writeParameter(s: string) {
            writer.writeParameter(s);
        }

        function writeComment(s: string) {
            writer.writeComment(s);
        }

        function writeSpace() {
            writer.writeSpace(" ");
        }

        function writeProperty(s: string) {
            writer.writeProperty(s);
        }

        function writeLine() {
            writer.writeLine();
        }

        function increaseIndent() {
            writer.increaseIndent();
        }

        function decreaseIndent() {
            writer.decreaseIndent();
        }

        function writeToken(token: SyntaxKind, pos: number, writer: (s: string) => void, contextNode?: Node) {
            return !sourceMapsDisabled
                ? emitTokenWithSourceMap(contextNode, token, writer, pos, writeTokenText)
                : writeTokenText(token, writer, pos);
        }

        function writeTokenNode(node: Node, writer: (s: string) => void) {
            if (onBeforeEmitToken) {
                onBeforeEmitToken(node);
            }
            writer(tokenToString(node.kind)!);
            if (onAfterEmitToken) {
                onAfterEmitToken(node);
            }
        }

        function writeTokenText(token: SyntaxKind, writer: (s: string) => void): void;
        function writeTokenText(token: SyntaxKind, writer: (s: string) => void, pos: number): number;
        function writeTokenText(token: SyntaxKind, writer: (s: string) => void, pos?: number): number {
            const tokenString = tokenToString(token)!;
            writer(tokenString);
            return pos! < 0 ? pos! : pos! + tokenString.length;
        }

        function writeLineOrSpace(node: Node) {
            if (getEmitFlags(node) & EmitFlags.SingleLine) {
                writeSpace();
            }
            else {
                writeLine();
            }
        }

        function writeLines(text: string): void {
            const lines = text.split(/\r\n?|\n/g);
            const indentation = guessIndentation(lines);
            for (const lineText of lines) {
                const line = indentation ? lineText.slice(indentation) : lineText;
                if (line.length) {
                    writeLine();
                    write(line);
                    writer.rawWrite(newLine);
                }
            }
        }

        function increaseIndentIf(value: boolean, writeSpaceIfNotIndenting: boolean) {
            if (value) {
                increaseIndent();
                writeLine();
            }
            else if (writeSpaceIfNotIndenting) {
                writeSpace();
            }
        }

        // Helper function to decrease the indent if we previously indented.  Allows multiple
        // previous indent values to be considered at a time.  This also allows caller to just
        // call this once, passing in all their appropriate indent values, instead of needing
        // to call this helper function multiple times.
        function decreaseIndentIf(value1: boolean, value2: boolean) {
            if (value1) {
                decreaseIndent();
            }
            if (value2) {
                decreaseIndent();
            }
        }

        function shouldWriteLeadingLineTerminator(parentNode: TextRange, children: NodeArray<Node>, format: ListFormat) {
            if (format & ListFormat.MultiLine) {
                return true;
            }

            if (format & ListFormat.PreserveLines) {
                if (format & ListFormat.PreferNewLine) {
                    return true;
                }

                const firstChild = children[0];
                if (firstChild === undefined) {
                    return !rangeIsOnSingleLine(parentNode, currentSourceFile!);
                }
                else if (positionIsSynthesized(parentNode.pos) || nodeIsSynthesized(firstChild)) {
                    return synthesizedNodeStartsOnNewLine(firstChild, format);
                }
                else {
                    return !rangeStartPositionsAreOnSameLine(parentNode, firstChild, currentSourceFile!);
                }
            }
            else {
                return false;
            }
        }

        function shouldWriteSeparatingLineTerminator(previousNode: Node | undefined, nextNode: Node, format: ListFormat) {
            if (format & ListFormat.MultiLine) {
                return true;
            }
            else if (format & ListFormat.PreserveLines) {
                if (previousNode === undefined || nextNode === undefined) {
                    return false;
                }
                else if (nodeIsSynthesized(previousNode) || nodeIsSynthesized(nextNode)) {
                    return synthesizedNodeStartsOnNewLine(previousNode, format) || synthesizedNodeStartsOnNewLine(nextNode, format);
                }
                else {
                    return !rangeEndIsOnSameLineAsRangeStart(previousNode, nextNode, currentSourceFile!);
                }
            }
            else {
                return getStartsOnNewLine(nextNode);
            }
        }

        function shouldWriteClosingLineTerminator(parentNode: TextRange, children: NodeArray<Node>, format: ListFormat) {
            if (format & ListFormat.MultiLine) {
                return (format & ListFormat.NoTrailingNewLine) === 0;
            }
            else if (format & ListFormat.PreserveLines) {
                if (format & ListFormat.PreferNewLine) {
                    return true;
                }

                const lastChild = lastOrUndefined(children);
                if (lastChild === undefined) {
                    return !rangeIsOnSingleLine(parentNode, currentSourceFile!);
                }
                else if (positionIsSynthesized(parentNode.pos) || nodeIsSynthesized(lastChild)) {
                    return synthesizedNodeStartsOnNewLine(lastChild, format);
                }
                else {
                    return !rangeEndPositionsAreOnSameLine(parentNode, lastChild, currentSourceFile!);
                }
            }
            else {
                return false;
            }
        }

        function synthesizedNodeStartsOnNewLine(node: Node, format: ListFormat) {
            if (nodeIsSynthesized(node)) {
                const startsOnNewLine = getStartsOnNewLine(node);
                if (startsOnNewLine === undefined) {
                    return (format & ListFormat.PreferNewLine) !== 0;
                }

                return startsOnNewLine;
            }

            return (format & ListFormat.PreferNewLine) !== 0;
        }

        function needsIndentation(parent: Node, node1: Node, node2: Node): boolean {
            parent = skipSynthesizedParentheses(parent);
            node1 = skipSynthesizedParentheses(node1);
            node2 = skipSynthesizedParentheses(node2);

            // Always use a newline for synthesized code if the synthesizer desires it.
            if (getStartsOnNewLine(node2)) {
                return true;
            }

            return !nodeIsSynthesized(parent)
                && !nodeIsSynthesized(node1)
                && !nodeIsSynthesized(node2)
                && !rangeEndIsOnSameLineAsRangeStart(node1, node2, currentSourceFile!);
        }

        function isEmptyBlock(block: BlockLike) {
            return block.statements.length === 0
                && rangeEndIsOnSameLineAsRangeStart(block, block, currentSourceFile!);
        }

        function skipSynthesizedParentheses(node: Node) {
            while (node.kind === SyntaxKind.ParenthesizedExpression && nodeIsSynthesized(node)) {
                node = (<ParenthesizedExpression>node).expression;
            }

            return node;
        }

        function getTextOfNode(node: Node, includeTrivia?: boolean): string {
            if (isGeneratedIdentifier(node)) {
                return generateName(node);
            }
            else if (isIdentifier(node) && (nodeIsSynthesized(node) || !node.parent || !currentSourceFile || (node.parent && currentSourceFile && getSourceFileOfNode(node) !== getOriginalNode(currentSourceFile)))) {
                return idText(node);
            }
            else if (node.kind === SyntaxKind.StringLiteral && (<StringLiteral>node).textSourceNode) {
                return getTextOfNode((<StringLiteral>node).textSourceNode!, includeTrivia);
            }
            else if (isLiteralExpression(node) && (nodeIsSynthesized(node) || !node.parent)) {
                return node.text;
            }

            return getSourceTextOfNodeFromSourceFile(currentSourceFile!, node, includeTrivia);
        }

        function getLiteralTextOfNode(node: LiteralLikeNode, neverAsciiEscape: boolean | undefined): string {
            if (node.kind === SyntaxKind.StringLiteral && (<StringLiteral>node).textSourceNode) {
                const textSourceNode = (<StringLiteral>node).textSourceNode!;
                if (isIdentifier(textSourceNode)) {
                    return neverAsciiEscape || (getEmitFlags(node) & EmitFlags.NoAsciiEscaping) ?
                        `"${escapeString(getTextOfNode(textSourceNode))}"` :
                        `"${escapeNonAsciiString(getTextOfNode(textSourceNode))}"`;
                }
                else {
                    return getLiteralTextOfNode(textSourceNode, neverAsciiEscape);
                }
            }

            return getLiteralText(node, currentSourceFile!, neverAsciiEscape);
        }

        /**
         * Push a new name generation scope.
         */
        function pushNameGenerationScope(node: Node | undefined) {
            if (node && getEmitFlags(node) & EmitFlags.ReuseTempVariableScope) {
                return;
            }
            tempFlagsStack.push(tempFlags);
            tempFlags = 0;
            reservedNamesStack.push(reservedNames);
        }

        /**
         * Pop the current name generation scope.
         */
        function popNameGenerationScope(node: Node | undefined) {
            if (node && getEmitFlags(node) & EmitFlags.ReuseTempVariableScope) {
                return;
            }
            tempFlags = tempFlagsStack.pop()!;
            reservedNames = reservedNamesStack.pop()!;
        }

        function reserveNameInNestedScopes(name: string) {
            if (!reservedNames || reservedNames === lastOrUndefined(reservedNamesStack)) {
                reservedNames = createMap<true>();
            }
            reservedNames.set(name, true);
        }

        function generateNames(node: Node | undefined) {
            if (!node) return;
            switch (node.kind) {
                case SyntaxKind.Block:
                    forEach((<Block>node).statements, generateNames);
                    break;
                case SyntaxKind.LabeledStatement:
                case SyntaxKind.WithStatement:
                case SyntaxKind.DoStatement:
                case SyntaxKind.WhileStatement:
                    generateNames((<LabeledStatement | WithStatement | DoStatement | WhileStatement>node).statement);
                    break;
                case SyntaxKind.IfStatement:
                    generateNames((<IfStatement>node).thenStatement);
                    generateNames((<IfStatement>node).elseStatement);
                    break;
                case SyntaxKind.ForStatement:
                case SyntaxKind.ForOfStatement:
                case SyntaxKind.ForInStatement:
                    generateNames((<ForStatement | ForInOrOfStatement>node).initializer);
                    generateNames((<ForStatement | ForInOrOfStatement>node).statement);
                    break;
                case SyntaxKind.SwitchStatement:
                    generateNames((<SwitchStatement>node).caseBlock);
                    break;
                case SyntaxKind.CaseBlock:
                    forEach((<CaseBlock>node).clauses, generateNames);
                    break;
                case SyntaxKind.CaseClause:
                case SyntaxKind.DefaultClause:
                    forEach((<CaseOrDefaultClause>node).statements, generateNames);
                    break;
                case SyntaxKind.TryStatement:
                    generateNames((<TryStatement>node).tryBlock);
                    generateNames((<TryStatement>node).catchClause);
                    generateNames((<TryStatement>node).finallyBlock);
                    break;
                case SyntaxKind.CatchClause:
                    generateNames((<CatchClause>node).variableDeclaration);
                    generateNames((<CatchClause>node).block);
                    break;
                case SyntaxKind.VariableStatement:
                    generateNames((<VariableStatement>node).declarationList);
                    break;
                case SyntaxKind.VariableDeclarationList:
                    forEach((<VariableDeclarationList>node).declarations, generateNames);
                    break;
                case SyntaxKind.VariableDeclaration:
                case SyntaxKind.Parameter:
                case SyntaxKind.BindingElement:
                case SyntaxKind.ClassDeclaration:
                    generateNameIfNeeded((<NamedDeclaration>node).name);
                    break;
                case SyntaxKind.FunctionDeclaration:
                    generateNameIfNeeded((<FunctionDeclaration>node).name);
                    if (getEmitFlags(node) & EmitFlags.ReuseTempVariableScope) {
                        forEach((<FunctionDeclaration>node).parameters, generateNames);
                        generateNames((<FunctionDeclaration>node).body);
                    }
                    break;
                case SyntaxKind.ObjectBindingPattern:
                case SyntaxKind.ArrayBindingPattern:
                    forEach((<BindingPattern>node).elements, generateNames);
                    break;
                case SyntaxKind.ImportDeclaration:
                    generateNames((<ImportDeclaration>node).importClause);
                    break;
                case SyntaxKind.ImportClause:
                    generateNameIfNeeded((<ImportClause>node).name);
                    generateNames((<ImportClause>node).namedBindings);
                    break;
                case SyntaxKind.NamespaceImport:
                    generateNameIfNeeded((<NamespaceImport>node).name);
                    break;
                case SyntaxKind.NamedImports:
                    forEach((<NamedImports>node).elements, generateNames);
                    break;
                case SyntaxKind.ImportSpecifier:
                    generateNameIfNeeded((<ImportSpecifier>node).propertyName || (<ImportSpecifier>node).name);
                    break;
            }
        }

        function generateMemberNames(node: Node | undefined) {
            if (!node) return;
            switch (node.kind) {
                case SyntaxKind.PropertyAssignment:
                case SyntaxKind.ShorthandPropertyAssignment:
                case SyntaxKind.PropertyDeclaration:
                case SyntaxKind.MethodDeclaration:
                case SyntaxKind.GetAccessor:
                case SyntaxKind.SetAccessor:
                    generateNameIfNeeded((<NamedDeclaration>node).name);
                    break;
            }
        }

        function generateNameIfNeeded(name: DeclarationName | undefined) {
            if (name) {
                if (isGeneratedIdentifier(name)) {
                    generateName(name);
                }
                else if (isBindingPattern(name)) {
                    generateNames(name);
                }
            }
        }

        /**
         * Generate the text for a generated identifier.
         */
        function generateName(name: GeneratedIdentifier) {
            if ((name.autoGenerateFlags & GeneratedIdentifierFlags.KindMask) === GeneratedIdentifierFlags.Node) {
                // Node names generate unique names based on their original node
                // and are cached based on that node's id.
                return generateNameCached(getNodeForGeneratedName(name), name.autoGenerateFlags);
            }
            else {
                // Auto, Loop, and Unique names are cached based on their unique
                // autoGenerateId.
                const autoGenerateId = name.autoGenerateId!;
                return autoGeneratedIdToGeneratedName[autoGenerateId] || (autoGeneratedIdToGeneratedName[autoGenerateId] = makeName(name));
            }
        }

        function generateNameCached(node: Node, flags?: GeneratedIdentifierFlags) {
            const nodeId = getNodeId(node);
            return nodeIdToGeneratedName[nodeId] || (nodeIdToGeneratedName[nodeId] = generateNameForNode(node, flags));
        }

        /**
         * Returns a value indicating whether a name is unique globally, within the current file,
         * or within the NameGenerator.
         */
        function isUniqueName(name: string): boolean {
            return isFileLevelUniqueName(name)
                && !generatedNames.has(name)
                && !(reservedNames && reservedNames.has(name));
        }

        /**
         * Returns a value indicating whether a name is unique globally or within the current file.
         */
        function isFileLevelUniqueName(name: string) {
            return currentSourceFile ? ts.isFileLevelUniqueName(currentSourceFile, name, hasGlobalName) : true;
        }

        /**
         * Returns a value indicating whether a name is unique within a container.
         */
        function isUniqueLocalName(name: string, container: Node): boolean {
            for (let node = container; isNodeDescendantOf(node, container); node = node.nextContainer!) {
                if (node.locals) {
                    const local = node.locals.get(escapeLeadingUnderscores(name));
                    // We conservatively include alias symbols to cover cases where they're emitted as locals
                    if (local && local.flags & (SymbolFlags.Value | SymbolFlags.ExportValue | SymbolFlags.Alias)) {
                        return false;
                    }
                }
            }
            return true;
        }

        /**
         * Return the next available name in the pattern _a ... _z, _0, _1, ...
         * TempFlags._i or TempFlags._n may be used to express a preference for that dedicated name.
         * Note that names generated by makeTempVariableName and makeUniqueName will never conflict.
         */
        function makeTempVariableName(flags: TempFlags, reservedInNestedScopes?: boolean): string {
            if (flags && !(tempFlags & flags)) {
                const name = flags === TempFlags._i ? "_i" : "_n";
                if (isUniqueName(name)) {
                    tempFlags |= flags;
                    if (reservedInNestedScopes) {
                        reserveNameInNestedScopes(name);
                    }
                    return name;
                }
            }
            while (true) {
                const count = tempFlags & TempFlags.CountMask;
                tempFlags++;
                // Skip over 'i' and 'n'
                if (count !== 8 && count !== 13) {
                    const name = count < 26
                        ? "_" + String.fromCharCode(CharacterCodes.a + count)
                        : "_" + (count - 26);
                    if (isUniqueName(name)) {
                        if (reservedInNestedScopes) {
                            reserveNameInNestedScopes(name);
                        }
                        return name;
                    }
                }
            }
        }

        /**
         * Generate a name that is unique within the current file and doesn't conflict with any names
         * in global scope. The name is formed by adding an '_n' suffix to the specified base name,
         * where n is a positive integer. Note that names generated by makeTempVariableName and
         * makeUniqueName are guaranteed to never conflict.
         * If `optimistic` is set, the first instance will use 'baseName' verbatim instead of 'baseName_1'
         */
        function makeUniqueName(baseName: string, checkFn: (name: string) => boolean = isUniqueName, optimistic?: boolean, scoped?: boolean): string {
            if (optimistic) {
                if (checkFn(baseName)) {
                    if (scoped) {
                        reserveNameInNestedScopes(baseName);
                    }
                    else {
                        generatedNames.set(baseName, true);
                    }
                    return baseName;
                }
            }
            // Find the first unique 'name_n', where n is a positive number
            if (baseName.charCodeAt(baseName.length - 1) !== CharacterCodes._) {
                baseName += "_";
            }
            let i = 1;
            while (true) {
                const generatedName = baseName + i;
                if (checkFn(generatedName)) {
                    if (scoped) {
                        reserveNameInNestedScopes(generatedName);
                    }
                    else {
                        generatedNames.set(generatedName, true);
                    }
                    return generatedName;
                }
                i++;
            }
        }

        function makeFileLevelOptimisticUniqueName(name: string) {
            return makeUniqueName(name, isFileLevelUniqueName, /*optimistic*/ true);
        }

        /**
         * Generates a unique name for a ModuleDeclaration or EnumDeclaration.
         */
        function generateNameForModuleOrEnum(node: ModuleDeclaration | EnumDeclaration) {
            const name = getTextOfNode(node.name);
            // Use module/enum name itself if it is unique, otherwise make a unique variation
            return isUniqueLocalName(name, node) ? name : makeUniqueName(name);
        }

        /**
         * Generates a unique name for an ImportDeclaration or ExportDeclaration.
         */
        function generateNameForImportOrExportDeclaration(node: ImportDeclaration | ExportDeclaration) {
            const expr = getExternalModuleName(node)!; // TODO: GH#18217
            const baseName = isStringLiteral(expr) ?
                makeIdentifierFromModuleName(expr.text) : "module";
            return makeUniqueName(baseName);
        }

        /**
         * Generates a unique name for a default export.
         */
        function generateNameForExportDefault() {
            return makeUniqueName("default");
        }

        /**
         * Generates a unique name for a class expression.
         */
        function generateNameForClassExpression() {
            return makeUniqueName("class");
        }

        function generateNameForMethodOrAccessor(node: MethodDeclaration | AccessorDeclaration) {
            if (isIdentifier(node.name)) {
                return generateNameCached(node.name);
            }
            return makeTempVariableName(TempFlags.Auto);
        }

        /**
         * Generates a unique name from a node.
         */
        function generateNameForNode(node: Node, flags?: GeneratedIdentifierFlags): string {
            switch (node.kind) {
                case SyntaxKind.Identifier:
                    return makeUniqueName(
                        getTextOfNode(node),
                        isUniqueName,
                        !!(flags! & GeneratedIdentifierFlags.Optimistic),
                        !!(flags! & GeneratedIdentifierFlags.ReservedInNestedScopes)
                    );
                case SyntaxKind.ModuleDeclaration:
                case SyntaxKind.EnumDeclaration:
                    return generateNameForModuleOrEnum(<ModuleDeclaration | EnumDeclaration>node);
                case SyntaxKind.ImportDeclaration:
                case SyntaxKind.ExportDeclaration:
                    return generateNameForImportOrExportDeclaration(<ImportDeclaration | ExportDeclaration>node);
                case SyntaxKind.FunctionDeclaration:
                case SyntaxKind.ClassDeclaration:
                case SyntaxKind.ExportAssignment:
                    return generateNameForExportDefault();
                case SyntaxKind.ClassExpression:
                    return generateNameForClassExpression();
                case SyntaxKind.MethodDeclaration:
                case SyntaxKind.GetAccessor:
                case SyntaxKind.SetAccessor:
                    return generateNameForMethodOrAccessor(<MethodDeclaration | AccessorDeclaration>node);
                default:
                    return makeTempVariableName(TempFlags.Auto);
            }
        }

        /**
         * Generates a unique identifier for a node.
         */
        function makeName(name: GeneratedIdentifier) {
            switch (name.autoGenerateFlags & GeneratedIdentifierFlags.KindMask) {
                case GeneratedIdentifierFlags.Auto:
                    return makeTempVariableName(TempFlags.Auto, !!(name.autoGenerateFlags & GeneratedIdentifierFlags.ReservedInNestedScopes));
                case GeneratedIdentifierFlags.Loop:
                    return makeTempVariableName(TempFlags._i, !!(name.autoGenerateFlags & GeneratedIdentifierFlags.ReservedInNestedScopes));
                case GeneratedIdentifierFlags.Unique:
                    return makeUniqueName(
                        idText(name),
                        (name.autoGenerateFlags & GeneratedIdentifierFlags.FileLevel) ? isFileLevelUniqueName : isUniqueName,
                        !!(name.autoGenerateFlags & GeneratedIdentifierFlags.Optimistic),
                        !!(name.autoGenerateFlags & GeneratedIdentifierFlags.ReservedInNestedScopes)
                    );
            }

            return Debug.fail("Unsupported GeneratedIdentifierKind.");
        }

        /**
         * Gets the node from which a name should be generated.
         */
        function getNodeForGeneratedName(name: GeneratedIdentifier) {
            const autoGenerateId = name.autoGenerateId;
            let node = name as Node;
            let original = node.original;
            while (original) {
                node = original;

                // if "node" is a different generated name (having a different
                // "autoGenerateId"), use it and stop traversing.
                if (isIdentifier(node)
                    && !!(node.autoGenerateFlags! & GeneratedIdentifierFlags.Node)
                    && node.autoGenerateId !== autoGenerateId) {
                    break;
                }

                original = node.original;
            }

            // otherwise, return the original node for the source;
            return node;
        }

        // Comments

        function pipelineEmitWithComments(hint: EmitHint, node: Node) {
            enterComment();
            hasWrittenComment = false;
            const emitFlags = getEmitFlags(node);
            const { pos, end } = getCommentRange(node);
            const isEmittedNode = node.kind !== SyntaxKind.NotEmittedStatement;

            // We have to explicitly check that the node is JsxText because if the compilerOptions.jsx is "preserve" we will not do any transformation.
            // It is expensive to walk entire tree just to set one kind of node to have no comments.
            const skipLeadingComments = pos < 0 || (emitFlags & EmitFlags.NoLeadingComments) !== 0 || node.kind === SyntaxKind.JsxText;
            const skipTrailingComments = end < 0 || (emitFlags & EmitFlags.NoTrailingComments) !== 0 || node.kind === SyntaxKind.JsxText;

            // Save current container state on the stack.
            const savedContainerPos = containerPos;
            const savedContainerEnd = containerEnd;
            const savedDeclarationListContainerEnd = declarationListContainerEnd;
            if ((pos > 0 || end > 0) && pos !== end) {
                // Emit leading comments if the position is not synthesized and the node
                // has not opted out from emitting leading comments.
                if (!skipLeadingComments) {
                    emitLeadingComments(pos, isEmittedNode);
                }

                if (!skipLeadingComments || (pos >= 0 && (emitFlags & EmitFlags.NoLeadingComments) !== 0)) {
                    // Advance the container position if comments get emitted or if they've been disabled explicitly using NoLeadingComments.
                    containerPos = pos;
                }

                if (!skipTrailingComments || (end >= 0 && (emitFlags & EmitFlags.NoTrailingComments) !== 0)) {
                    // As above.
                    containerEnd = end;

                    // To avoid invalid comment emit in a down-level binding pattern, we
                    // keep track of the last declaration list container's end
                    if (node.kind === SyntaxKind.VariableDeclarationList) {
                        declarationListContainerEnd = end;
                    }
                }
            }
            forEach(getSyntheticLeadingComments(node), emitLeadingSynthesizedComment);
            exitComment();

            const pipelinePhase = getNextPipelinePhase(PipelinePhase.Comments, node);
            if (emitFlags & EmitFlags.NoNestedComments) {
                commentsDisabled = true;
                pipelinePhase(hint, node);
                commentsDisabled = false;
            }
            else {
                pipelinePhase(hint, node);
            }

            enterComment();
            forEach(getSyntheticTrailingComments(node), emitTrailingSynthesizedComment);
            if ((pos > 0 || end > 0) && pos !== end) {
                // Restore previous container state.
                containerPos = savedContainerPos;
                containerEnd = savedContainerEnd;
                declarationListContainerEnd = savedDeclarationListContainerEnd;

                // Emit trailing comments if the position is not synthesized and the node
                // has not opted out from emitting leading comments and is an emitted node.
                if (!skipTrailingComments && isEmittedNode) {
                    emitTrailingComments(end);
                }
            }
            exitComment();
        }

        function emitLeadingSynthesizedComment(comment: SynthesizedComment) {
            if (comment.kind === SyntaxKind.SingleLineCommentTrivia) {
                writer.writeLine();
            }
            writeSynthesizedComment(comment);
            if (comment.hasTrailingNewLine || comment.kind === SyntaxKind.SingleLineCommentTrivia) {
                writer.writeLine();
            }
            else {
                writer.writeSpace(" ");
            }
        }

        function emitTrailingSynthesizedComment(comment: SynthesizedComment) {
            if (!writer.isAtStartOfLine()) {
                writer.writeSpace(" ");
            }
            writeSynthesizedComment(comment);
            if (comment.hasTrailingNewLine) {
                writer.writeLine();
            }
        }

        function writeSynthesizedComment(comment: SynthesizedComment) {
            const text = formatSynthesizedComment(comment);
            const lineMap = comment.kind === SyntaxKind.MultiLineCommentTrivia ? computeLineStarts(text) : undefined;
            writeCommentRange(text, lineMap!, writer, 0, text.length, newLine);
        }

        function formatSynthesizedComment(comment: SynthesizedComment) {
            return comment.kind === SyntaxKind.MultiLineCommentTrivia
                ? `/*${comment.text}*/`
                : `//${comment.text}`;
        }

        function emitBodyWithDetachedComments(node: Node, detachedRange: TextRange, emitCallback: (node: Node) => void) {
            enterComment();
            const { pos, end } = detachedRange;
            const emitFlags = getEmitFlags(node);
            const skipLeadingComments = pos < 0 || (emitFlags & EmitFlags.NoLeadingComments) !== 0;
            const skipTrailingComments = commentsDisabled || end < 0 || (emitFlags & EmitFlags.NoTrailingComments) !== 0;
            if (!skipLeadingComments) {
                emitDetachedCommentsAndUpdateCommentsInfo(detachedRange);
            }

            exitComment();
            if (emitFlags & EmitFlags.NoNestedComments && !commentsDisabled) {
                commentsDisabled = true;
                emitCallback(node);
                commentsDisabled = false;
            }
            else {
                emitCallback(node);
            }

            enterComment();
            if (!skipTrailingComments) {
                emitLeadingComments(detachedRange.end, /*isEmittedNode*/ true);
                if (hasWrittenComment && !writer.isAtStartOfLine()) {
                    writer.writeLine();
                }
            }
            exitComment();

        }

        function emitLeadingComments(pos: number, isEmittedNode: boolean) {
            hasWrittenComment = false;

            if (isEmittedNode) {
                forEachLeadingCommentToEmit(pos, emitLeadingComment);
            }
            else if (pos === 0) {
                // If the node will not be emitted in JS, remove all the comments(normal, pinned and ///) associated with the node,
                // unless it is a triple slash comment at the top of the file.
                // For Example:
                //      /// <reference-path ...>
                //      declare var x;
                //      /// <reference-path ...>
                //      interface F {}
                //  The first /// will NOT be removed while the second one will be removed even though both node will not be emitted
                forEachLeadingCommentToEmit(pos, emitTripleSlashLeadingComment);
            }
        }

        function emitTripleSlashLeadingComment(commentPos: number, commentEnd: number, kind: SyntaxKind, hasTrailingNewLine: boolean, rangePos: number) {
            if (isTripleSlashComment(commentPos, commentEnd)) {
                emitLeadingComment(commentPos, commentEnd, kind, hasTrailingNewLine, rangePos);
            }
        }

        function shouldWriteComment(text: string, pos: number) {
            if (printerOptions.onlyPrintJsDocStyle) {
                return (isJSDocLikeText(text, pos) || isPinnedComment(text, pos));
            }
            return true;
        }

        function emitLeadingComment(commentPos: number, commentEnd: number, kind: SyntaxKind, hasTrailingNewLine: boolean, rangePos: number) {
            if (!shouldWriteComment(currentSourceFile!.text, commentPos)) return;
            if (!hasWrittenComment) {
                emitNewLineBeforeLeadingCommentOfPosition(getCurrentLineMap(), writer, rangePos, commentPos);
                hasWrittenComment = true;
            }

            // Leading comments are emitted at /*leading comment1 */space/*leading comment*/space
            emitPos(commentPos);
            writeCommentRange(currentSourceFile!.text, getCurrentLineMap(), writer, commentPos, commentEnd, newLine);
            emitPos(commentEnd);

            if (hasTrailingNewLine) {
                writer.writeLine();
            }
            else if (kind === SyntaxKind.MultiLineCommentTrivia) {
                writer.writeSpace(" ");
            }
        }

        function emitLeadingCommentsOfPosition(pos: number) {
            if (commentsDisabled || pos === -1) {
                return;
            }

            emitLeadingComments(pos, /*isEmittedNode*/ true);
        }

        function emitTrailingComments(pos: number) {
            forEachTrailingCommentToEmit(pos, emitTrailingComment);
        }

        function emitTrailingComment(commentPos: number, commentEnd: number, _kind: SyntaxKind, hasTrailingNewLine: boolean) {
            if (!shouldWriteComment(currentSourceFile!.text, commentPos)) return;
            // trailing comments are emitted at space/*trailing comment1 */space/*trailing comment2*/
            if (!writer.isAtStartOfLine()) {
                writer.writeSpace(" ");
            }

            emitPos(commentPos);
            writeCommentRange(currentSourceFile!.text, getCurrentLineMap(), writer, commentPos, commentEnd, newLine);
            emitPos(commentEnd);

            if (hasTrailingNewLine) {
                writer.writeLine();
            }
        }

        function emitTrailingCommentsOfPosition(pos: number, prefixSpace?: boolean) {
            if (commentsDisabled) {
                return;
            }
            enterComment();
            forEachTrailingCommentToEmit(pos, prefixSpace ? emitTrailingComment : emitTrailingCommentOfPosition);
            exitComment();
        }

        function emitTrailingCommentOfPosition(commentPos: number, commentEnd: number, _kind: SyntaxKind, hasTrailingNewLine: boolean) {
            // trailing comments of a position are emitted at /*trailing comment1 */space/*trailing comment*/space

            emitPos(commentPos);
            writeCommentRange(currentSourceFile!.text, getCurrentLineMap(), writer, commentPos, commentEnd, newLine);
            emitPos(commentEnd);

            if (hasTrailingNewLine) {
                writer.writeLine();
            }
            else {
                writer.writeSpace(" ");
            }
        }

        function forEachLeadingCommentToEmit(pos: number, cb: (commentPos: number, commentEnd: number, kind: SyntaxKind, hasTrailingNewLine: boolean, rangePos: number) => void) {
            // Emit the leading comments only if the container's pos doesn't match because the container should take care of emitting these comments
            if (currentSourceFile && (containerPos === -1 || pos !== containerPos)) {
                if (hasDetachedComments(pos)) {
                    forEachLeadingCommentWithoutDetachedComments(cb);
                }
                else {
                    forEachLeadingCommentRange(currentSourceFile.text, pos, cb, /*state*/ pos);
                }
            }
        }

        function forEachTrailingCommentToEmit(end: number, cb: (commentPos: number, commentEnd: number, kind: SyntaxKind, hasTrailingNewLine: boolean) => void) {
            // Emit the trailing comments only if the container's end doesn't match because the container should take care of emitting these comments
            if (currentSourceFile && (containerEnd === -1 || (end !== containerEnd && end !== declarationListContainerEnd))) {
                forEachTrailingCommentRange(currentSourceFile.text, end, cb);
            }
        }

        function hasDetachedComments(pos: number) {
            return detachedCommentsInfo !== undefined && last(detachedCommentsInfo).nodePos === pos;
        }

        function forEachLeadingCommentWithoutDetachedComments(cb: (commentPos: number, commentEnd: number, kind: SyntaxKind, hasTrailingNewLine: boolean, rangePos: number) => void) {
            // get the leading comments from detachedPos
            const pos = last(detachedCommentsInfo!).detachedCommentEndPos;
            if (detachedCommentsInfo!.length - 1) {
                detachedCommentsInfo!.pop();
            }
            else {
                detachedCommentsInfo = undefined;
            }

            forEachLeadingCommentRange(currentSourceFile!.text, pos, cb, /*state*/ pos);
        }

        function emitDetachedCommentsAndUpdateCommentsInfo(range: TextRange) {
            const currentDetachedCommentInfo = emitDetachedComments(currentSourceFile!.text, getCurrentLineMap(), writer, emitComment, range, newLine, commentsDisabled);
            if (currentDetachedCommentInfo) {
                if (detachedCommentsInfo) {
                    detachedCommentsInfo.push(currentDetachedCommentInfo);
                }
                else {
                    detachedCommentsInfo = [currentDetachedCommentInfo];
                }
            }
        }

        function emitComment(text: string, lineMap: number[], writer: EmitTextWriter, commentPos: number, commentEnd: number, newLine: string) {
            if (!shouldWriteComment(currentSourceFile!.text, commentPos)) return;
            emitPos(commentPos);
            writeCommentRange(text, lineMap, writer, commentPos, commentEnd, newLine);
            emitPos(commentEnd);
        }

        /**
         * Determine if the given comment is a triple-slash
         *
         * @return true if the comment is a triple-slash comment else false
         */
        function isTripleSlashComment(commentPos: number, commentEnd: number) {
            return isRecognizedTripleSlashComment(currentSourceFile!.text, commentPos, commentEnd);
        }

        // Source Maps

        function pipelineEmitWithSourceMap(hint: EmitHint, node: Node) {
            const pipelinePhase = getNextPipelinePhase(PipelinePhase.SourceMaps, node);
            if (isUnparsedSource(node) && node.sourceMapText !== undefined) {
                const parsed = tryParseRawSourceMap(node.sourceMapText);
                if (parsed) {
                    sourceMapGenerator!.appendSourceMap(
                        writer.getLine(),
                        writer.getColumn(),
                        parsed,
                        node.sourceMapPath!);
                }
                pipelinePhase(hint, node);
            }
            else {
                const { pos, end, source = sourceMapSource } = getSourceMapRange(node);
                const emitFlags = getEmitFlags(node);
                if (node.kind !== SyntaxKind.NotEmittedStatement
                    && (emitFlags & EmitFlags.NoLeadingSourceMap) === 0
                    && pos >= 0) {
                    emitSourcePos(source, skipSourceTrivia(source, pos));
                }

                if (emitFlags & EmitFlags.NoNestedSourceMaps) {
                    sourceMapsDisabled = true;
                    pipelinePhase(hint, node);
                    sourceMapsDisabled = false;
                }
                else {
                    pipelinePhase(hint, node);
                }

                if (node.kind !== SyntaxKind.NotEmittedStatement
                    && (emitFlags & EmitFlags.NoTrailingSourceMap) === 0
                    && end >= 0) {
                    emitSourcePos(source, end);
                }
            }
        }

        /**
         * Skips trivia such as comments and white-space that can optionally overriden by the source map source
         */
        function skipSourceTrivia(source: SourceMapSource, pos: number): number {
            return source.skipTrivia ? source.skipTrivia(pos) : skipTrivia(sourceMapSource.text, pos);
        }

        /**
         * Emits a mapping.
         *
         * If the position is synthetic (undefined or a negative value), no mapping will be
         * created.
         *
         * @param pos The position.
         */
        function emitPos(pos: number) {
            if (sourceMapsDisabled || positionIsSynthesized(pos) || isJsonSourceMapSource(sourceMapSource)) {
                return;
            }

            const { line: sourceLine, character: sourceCharacter } = getLineAndCharacterOfPosition(sourceMapSource, pos);
            sourceMapGenerator!.addMapping(
                writer.getLine(),
                writer.getColumn(),
                sourceMapSourceIndex,
                sourceLine,
                sourceCharacter,
                /*nameIndex*/ undefined);
        }

        function emitSourcePos(source: SourceMapSource, pos: number) {
            if (source !== sourceMapSource) {
                const savedSourceMapSource = sourceMapSource;
                setSourceMapSource(source);
                emitPos(pos);
                setSourceMapSource(savedSourceMapSource);
            }
            else {
                emitPos(pos);
            }
        }

        /**
         * Emits a token of a node with possible leading and trailing source maps.
         *
         * @param node The node containing the token.
         * @param token The token to emit.
         * @param tokenStartPos The start pos of the token.
         * @param emitCallback The callback used to emit the token.
         */
        function emitTokenWithSourceMap(node: Node | undefined, token: SyntaxKind, writer: (s: string) => void, tokenPos: number, emitCallback: (token: SyntaxKind, writer: (s: string) => void, tokenStartPos: number) => number) {
            if (sourceMapsDisabled || node && isInJsonFile(node)) {
                return emitCallback(token, writer, tokenPos);
            }

            const emitNode = node && node.emitNode;
            const emitFlags = emitNode && emitNode.flags || EmitFlags.None;
            const range = emitNode && emitNode.tokenSourceMapRanges && emitNode.tokenSourceMapRanges[token];
            const source = range && range.source || sourceMapSource;

            tokenPos = skipSourceTrivia(source, range ? range.pos : tokenPos);
            if ((emitFlags & EmitFlags.NoTokenLeadingSourceMaps) === 0 && tokenPos >= 0) {
                emitSourcePos(source, tokenPos);
            }

            tokenPos = emitCallback(token, writer, tokenPos);

            if (range) tokenPos = range.end;
            if ((emitFlags & EmitFlags.NoTokenTrailingSourceMaps) === 0 && tokenPos >= 0) {
                emitSourcePos(source, tokenPos);
            }

            return tokenPos;
        }

        function setSourceMapSource(source: SourceMapSource) {
            if (sourceMapsDisabled) {
                return;
            }

            sourceMapSource = source;

            if (isJsonSourceMapSource(source)) {
                return;
            }

            sourceMapSourceIndex = sourceMapGenerator!.addSource(source.fileName);
            if (printerOptions.inlineSources) {
                sourceMapGenerator!.setSourceContent(sourceMapSourceIndex, source.text);
            }
        }

        function isJsonSourceMapSource(sourceFile: SourceMapSource) {
            return fileExtensionIs(sourceFile.fileName, Extension.Json);
        }
    }

    function createBracketsMap() {
        const brackets: string[][] = [];
        brackets[ListFormat.Braces] = ["{", "}"];
        brackets[ListFormat.Parenthesis] = ["(", ")"];
        brackets[ListFormat.AngleBrackets] = ["<", ">"];
        brackets[ListFormat.SquareBrackets] = ["[", "]"];
        return brackets;
    }

    function getOpeningBracket(format: ListFormat) {
        return brackets[format & ListFormat.BracketsMask][0];
    }

    function getClosingBracket(format: ListFormat) {
        return brackets[format & ListFormat.BracketsMask][1];
    }

    // Flags enum to track count of temp variables and a few dedicated names
    const enum TempFlags {
        Auto = 0x00000000,  // No preferred name
        CountMask = 0x0FFFFFFF,  // Temp variable counter
        _i = 0x10000000,  // Use/preference flag for '_i'
    }
}
