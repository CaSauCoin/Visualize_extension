import * as vscode from 'vscode';
import { CppParser } from './CppParser';
import { WebviewManager } from './WebviewManager';
import { RepoScanner } from './RepoScanner';
import { GraphResult } from './RepoScanner';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    const parser = new CppParser();
    const webviewManager = new WebviewManager(context);
    const repoScanner = new RepoScanner();

    // --- STATE MANAGEMENT (persist state) ---
    let cachedRepoGraph: string = ""; // Mermaid string for the current repo graph
    let cachedSelectedFolders: string[] = []; // Currently selected folder filters
    // ---------------------------------------

    // Command: Visualize current file ("Back" button is hidden in this mode)
    let cmdFile = vscode.commands.registerCommand('cpp-viz-tool.visualizeFile', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showErrorMessage('Please open a C++ file!'); return; }
        
        const mermaid = parser.parseFlowchart(editor.document.getText());
        webviewManager.showGraph(mermaid, `Flowchart: ${path.basename(editor.document.fileName)}`, 'FILE');
        
        // Setup listener (to handle webview events)
        setupWebviewListener(); 
    });

    // Command: Visualize Repo
    let cmdRepo = vscode.commands.registerCommand('cpp-viz-tool.visualizeRepo', async () => {
        await runRepoVizWorkflow();
    });

    // --- MAIN WORKFLOW LOGIC ---

    // 1. Folder selection + repo graph workflow
    async function runRepoVizWorkflow(forcePick: boolean = true) {
        
        // If folders are cached and we don't force picking again (e.g. Refresh), reuse prior selection
        let targetFolders = cachedSelectedFolders;

        if (forcePick) {
            vscode.window.setStatusBarMessage('Scanning folders...', 2000);
            const folders = await repoScanner.getProjectFolders();

            if (folders.length === 0) {
                vscode.window.showErrorMessage('No source folders found.');
                return;
            }

            // QuickPick: Let user choose folders (preselect previous ones)
            const selectedItems = await vscode.window.showQuickPick(folders, {
                canPickMany: true,
                placeHolder: 'Select folders to display (Esc to keep current)',
                title: 'Filter Project Graph'
            });

            // If user cancels (Esc), do not redraw (keep the current view, if any)
            if (!selectedItems) return;

            targetFolders = selectedItems;
            cachedSelectedFolders = targetFolders; // Persist new selection
        }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Rendering dependency graph...",
            cancellable: false
        }, async () => {
            try {
                // Generate Graph
				const result = await repoScanner.generateDependencyGraph(targetFolders.length > 0 ? targetFolders : null);                
                // Update cache

                // Render
                webviewManager.showGraph(result.mermaid, 'Project Dependency Graph', 'REPO', result.adjacency);
                
                // Start listening to events from the Webview
                setupWebviewListener();

            } catch (err) {
                vscode.window.showErrorMessage('Error: ' + err);
            }
        });
    }

    // 2. Setup listener to handle messages from the Webview
    function setupWebviewListener() {
        if (webviewManager.panel) {
            webviewManager.panel.webview.onDidReceiveMessage(
                async (message) => {
                    switch (message.command) {
                        
                        // User clicks a node in the repo graph
                        case 'openAndVisualize':
                            const filePath = message.path;
                            try {
                                const doc = await vscode.workspace.openTextDocument(filePath);
                                await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                                
                                const flowchart = parser.parseFlowchart(doc.getText());
                                // Switch to FILE mode (show Back button)
                                webviewManager.showGraph(flowchart, `Flowchart: ${path.basename(filePath)}`, 'FILE');
                            } catch (e) {
                                vscode.window.showErrorMessage(`Could not open file: ${e}`);
                            }
                            return;

                        // User clicks "Back to Repo"
                        case 'backToRepo':
                            if (cachedRepoGraph) {
                                // Reload cached graph immediately
                                webviewManager.showGraph(cachedRepoGraph, 'Project Dependency Graph', 'REPO');
                            } else {
                                // If there is no cache, re-run the workflow
                                await runRepoVizWorkflow(true);
                            }
                            return;

                        // User clicks "Filter"
                        case 'filterFolders':
                            // Re-run the folder selection workflow (Force Pick = true)
                            await runRepoVizWorkflow(true);
                            return;
                        
                        // User clicks "Refresh"
                        case 'refreshRepo':
                            // Re-run the workflow while keeping existing folders (Force Pick = false)
                            // If you want refresh without confirming selection, call runRepoVizWorkflow(false).
                            await runRepoVizWorkflow(false); 
                            return;
                    }
                },
                undefined,
                context.subscriptions
            );
        }
    }

    context.subscriptions.push(cmdFile, cmdRepo);
}

export function deactivate() {}
