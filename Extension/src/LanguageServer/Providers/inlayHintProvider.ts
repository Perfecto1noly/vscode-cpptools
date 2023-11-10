/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as vscode from 'vscode';
import { Position } from 'vscode-languageclient';
import { ManualPromise } from '../../Utility/Async/manualPromise';
import { CppSettings } from '../settings';

interface FileData
{
    version: number;
    promise: ManualPromise<vscode.InlayHint[]>;
    inlayHints: vscode.InlayHint[];
}

export interface CppInlayHint {
    position: Position;
    label: string;
    inlayHintKind: InlayHintKind;
    isValueRef: boolean;
    hasParamName: boolean;
    leftPadding: boolean;
    rightPadding: boolean;
    identifierLength: number;
}

// interface GetInlayHintsParams {
//     uri: string;
// }

enum InlayHintKind {
    Type = 0,
    Parameter = 1,
}

// interface GetInlayHintsResult {
//     fileVersion: number;
//     inlayHints: CppInlayHint[];
// }

// type InlayHintsCacheEntry = {
//     FileVersion: number;
//     TypeHints: CppInlayHint[];
//     ParameterHints: CppInlayHint[];
// };

// const GetInlayHintsRequest: RequestType<GetInlayHintsParams, GetInlayHintsResult, void> =
//     new RequestType<GetInlayHintsParams, GetInlayHintsResult, void>('cpptools/getInlayHints');

export class InlayHintsProvider implements vscode.InlayHintsProvider {
    public onDidChangeInlayHintsEvent = new vscode.EventEmitter<void>();
    public onDidChangeInlayHints?: vscode.Event<void> = this.onDidChangeInlayHintsEvent.event;
    private allFileData: Map<string, FileData> = new Map<string, FileData>();

    public async provideInlayHints(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken): Promise<vscode.InlayHint[]> {
        const uri: vscode.Uri = document.uri;
        const uriString: string = uri.toString();
        let fileData: FileData | undefined = this.allFileData.get(uriString);
        if (fileData) {
            if (fileData.promise.isCompleted) {
                // Make sure file hasn't been changed since the last set of results.
                // If a complete promise is present, there should also be a cache.
                if (fileData.version === document.version) {
                    return fileData.promise;
                }
                this.allFileData.delete(uriString);
            } else {
                // A new request requires a new ManualPromise, as each promise returned needs
                // to be associated with the cancellation token provided at the time.
                fileData.promise.reject(new vscode.CancellationError());
            }
        }
        fileData = {
            version: document.version,
            promise: new ManualPromise<vscode.InlayHint[]>(),
            inlayHints: []
        };
        this.allFileData.set(uriString, fileData);

        // Capture a local variable instead of referring to the member variable directly,
        // to avoid race conditions where the member variable is changed before the
        // cancallation token is triggered.
        const currentPromise = fileData.promise;
        token.onCancellationRequested(() => {
            const fileData: FileData | undefined = this.allFileData.get(uriString);
            if (fileData && currentPromise === fileData.promise) {
                this.allFileData.delete(uriString);
                currentPromise.reject(new vscode.CancellationError());
            }
        });

        return currentPromise;

        // await this.client.ready;
        // const uriString: string = document.uri.toString();

        // // Get results from cache if available.
        // let cacheEntry: InlayHintsCacheEntry | undefined = this.cache.get(uriString);
        // if (cacheEntry?.FileVersion === document.version) {
        //     return this.buildVSCodeHints(document.uri, cacheEntry);
        // }

        // // Get new results from the language server
        // const params: GetInlayHintsParams = { uri: uriString };
        // const inlayHintsResult: GetInlayHintsResult = await this.client.languageClient.sendRequest(GetInlayHintsRequest, params, token);
        // if (token.isCancellationRequested || inlayHintsResult.inlayHints === undefined || inlayHintsResult.fileVersion !== openFileVersions.get(uriString)) {
        //     throw new vscode.CancellationError();
        // }

        // cacheEntry = this.createCacheEntry(inlayHintsResult);
        // this.cache.set(uriString, cacheEntry);
        // return this.buildVSCodeHints(document.uri, cacheEntry);
    }

    public deliverInlayHints(uriString: string, cppInlayHints: CppInlayHint[], startNewSet: boolean): void {
        if (!startNewSet && cppInlayHints.length === 0) {
            return;
        }

        const editor: vscode.TextEditor | undefined = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uriString);
        if (!editor) {
            this.allFileData.get(uriString)?.promise.resolve([]);
            return;
        }

        // No need to check the file version here, as the caller has already ensured it's current.

        let fileData: FileData | undefined = this.allFileData.get(uriString);
        let needsNewPromise: boolean = false;
        let inlayHints: vscode.InlayHint[] | undefined;
        if (!fileData) {
            needsNewPromise = true;
        } else {
            if (!fileData.promise.isPending) {
                needsNewPromise = true;
            }
            if (!startNewSet) {
                inlayHints = fileData.inlayHints;
            }
        }
        if (!inlayHints) {
            inlayHints = [];
        }

        if (needsNewPromise) {
            fileData = {
                version: editor.document.version,
                promise: new ManualPromise<vscode.InlayHint[]>(),
                inlayHints: inlayHints
            };
            this.allFileData.set(uriString, fileData);
        } else if (fileData) {
            fileData.inlayHints = inlayHints;
        }

        const typeHints: CppInlayHint[] = cppInlayHints.filter(h => h.inlayHintKind === InlayHintKind.Type);
        const paramHints: CppInlayHint[] = cppInlayHints.filter(h => h.inlayHintKind === InlayHintKind.Parameter);

        const settings: CppSettings = new CppSettings(vscode.Uri.parse(uriString));
        if (settings.inlayHintsAutoDeclarationTypes) {
            const resolvedTypeHints: vscode.InlayHint[] = this.resolveTypeHints(settings, typeHints);
            Array.prototype.push.apply(inlayHints, resolvedTypeHints);
        }
        if (settings.inlayHintsParameterNames || settings.inlayHintsReferenceOperator) {
            const resolvedParameterHints: vscode.InlayHint[] = this.resolveParameterHints(settings, paramHints);
            Array.prototype.push.apply(inlayHints, resolvedParameterHints);
        }

        fileData?.promise.resolve(inlayHints);
        if (needsNewPromise) {
            this.onDidChangeInlayHintsEvent.fire();
        }
    }

    public removeFile(uriString: string): void {
        const fileData: FileData | undefined = this.allFileData.get(uriString);
        if (!fileData) {
            return;
        }
        if (fileData.promise.isPending) {
            fileData.promise.reject(new vscode.CancellationError());
        }
        this.allFileData.delete(uriString);
        this.onDidChangeInlayHintsEvent.fire();
    }

    private resolveTypeHints(settings: CppSettings, hints: CppInlayHint[]): vscode.InlayHint[] {
        const resolvedHints: vscode.InlayHint[] = [];
        for (const hint of hints) {
            const showOnLeft: boolean = settings.inlayHintsAutoDeclarationTypesShowOnLeft && hint.identifierLength > 0;
            const inlayHint: vscode.InlayHint = new vscode.InlayHint(
                new vscode.Position(hint.position.line, hint.position.character +
                    (showOnLeft ? 0 : hint.identifierLength)),
                showOnLeft ? hint.label : ": " + hint.label,
                vscode.InlayHintKind.Type);
            inlayHint.paddingRight = showOnLeft || hint.rightPadding;
            inlayHint.paddingLeft = showOnLeft && hint.leftPadding;
            resolvedHints.push(inlayHint);
        }
        return resolvedHints;
    }

    private resolveParameterHints(settings: CppSettings, hints: CppInlayHint[]): vscode.InlayHint[] {
        const resolvedHints: vscode.InlayHint[] = [];
        for (const hint of hints) {
            // Build parameter label based on settings.
            let paramHintLabel: string = "";
            if (settings.inlayHintsParameterNames) {
                paramHintLabel = (settings.inlayHintsParameterNamesSuppressName && hint.hasParamName) ? "" : hint.label;
                if (paramHintLabel !== "" && settings.inlayHintsParameterNamesHideLeadingUnderscores) {
                    let nonUnderscoreIndex: number = 0;
                    for (let i: number = 0; i < paramHintLabel.length; ++i) {
                        if (paramHintLabel[i] !== '_') {
                            nonUnderscoreIndex = i;
                            break;
                        }
                    }
                    if (nonUnderscoreIndex > 0) {
                        paramHintLabel = paramHintLabel.substring(nonUnderscoreIndex);
                    }
                }
            }
            let refOperatorString: string = "";
            if (settings.inlayHintsReferenceOperator && hint.isValueRef) {
                refOperatorString = (paramHintLabel !== "" && settings.inlayHintsReferenceOperatorShowSpace) ? "& " : "&";
            }

            if (paramHintLabel === "" && refOperatorString === "") {
                continue;
            }

            const inlayHint: vscode.InlayHint = new vscode.InlayHint(
                new vscode.Position(hint.position.line, hint.position.character),
                refOperatorString + paramHintLabel + ":",
                vscode.InlayHintKind.Parameter);
            inlayHint.paddingRight = true;
            resolvedHints.push(inlayHint);
        }
        return resolvedHints;
    }
}
