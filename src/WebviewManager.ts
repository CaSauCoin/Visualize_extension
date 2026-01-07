import * as vscode from 'vscode';

export class WebviewManager {
    public panel: vscode.WebviewPanel | undefined;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Main function to render the graph
     * @param graphDefinition Mermaid string
     * @param title Window title
     * @param mode 'REPO' (Project View) or 'FILE' (Function View)
     * @param adjacencyData Object containing connection info for highlighting
     */
    public showGraph(graphDefinition: string, title: string, mode: 'REPO' | 'FILE', adjacencyData: any = {}) {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Two);
        } else {
            this.panel = vscode.window.createWebviewPanel(
                'cppViz',
                'C++ Architecture', // Extension Title
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
                    retainContextWhenHidden: true // Keep state when switching tabs
                }
            );
            
            // Clean up when closed
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            }, null, this.context.subscriptions);
        }

        const scriptPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'mermaid.min.js');
        const scriptUri = this.panel.webview.asWebviewUri(scriptPath);

        this.panel.webview.html = this.getHtml(scriptUri, graphDefinition, title, mode, adjacencyData);
    }

    private getHtml(scriptUri: vscode.Uri, graphDefinition: string, title: string, mode: 'REPO' | 'FILE', adjacencyData: any): string {
        const cspSource = this.panel!.webview.cspSource;
        // Escape backticks for JS template string
        const safeGraph = graphDefinition.replace(/`/g, '\\`');
        // Serialize adjacency data for JS
        const safeAdjacency = JSON.stringify(adjacencyData);

        // --- BUTTONS CONFIGURATION (ENGLISH) ---
        let buttons = '';
        if (mode === 'REPO') {
            buttons = `
                <button class="btn primary" onclick="sendCommand('filterFolders')">📂 Filter Folders</button>
                <button class="btn" onclick="sendCommand('refreshRepo')">🔄 Refresh</button>
            `;
        } else {
            buttons = `
                <button class="btn warning" onclick="sendCommand('backToRepo')">⬅ Back to Repo</button>
                <button class="btn" onclick="copyCode()">📋 Copy Mermaid</button>
            `;
        }

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};">
            <style>
                body { 
                    background-color: #1e1e1e; color: #fff; font-family: 'Segoe UI', sans-serif; 
                    height: 100vh; display: flex; flex-direction: column; margin: 0; overflow: hidden; 
                    user-select: none; /* Prevent text selection while dragging */
                }
                
                /* HEADER STYLES */
                .header { 
                    padding: 8px 15px; background: #252526; border-bottom: 1px solid #333; 
                    display: flex; justify-content: space-between; align-items: center; 
                    z-index: 10; box-shadow: 0 2px 4px rgba(0,0,0,0.2); 
                }
                .title { font-weight: 600; font-size: 14px; color: #e7e7e7; }
                .controls { display: flex; gap: 8px; }
                
                /* BUTTON STYLES */
                .btn { 
                    background: #3c3c3c; color: #ccc; border: 1px solid #444; 
                    padding: 4px 12px; cursor: pointer; font-size: 12px; border-radius: 3px; 
                    transition: background 0.2s;
                }
                .btn:hover { background: #4c4c4c; color: white; }
                .btn.primary { background: #0e639c; border-color: #1177bb; color: white; }
                .btn.primary:hover { background: #1177bb; }
                .btn.warning { background: #8f6f00; border-color: #a88800; color: white; }
                .btn.warning:hover { background: #a88800; }

                /* GRAPH CONTAINER */
                #graph-container { flex: 1; overflow: hidden; position: relative; background: #1e1e1e; }
                #zoom-layer { position: absolute; width: 100%; height: 100%; transform-origin: 0 0; }
                
                /* HIGHLIGHT EFFECTS */
                .dimmed .node { opacity: 0.1; transition: opacity 0.3s; }
                .dimmed .edgePath { opacity: 0.05; transition: opacity 0.3s; }
                .dimmed .cluster { opacity: 0.2; }
                
                /* Active Node Style */
                .dimmed .node.active { 
                    opacity: 1 !important; 
                    filter: drop-shadow(0 0 8px rgba(0, 122, 204, 0.6)); 
                }
                .dimmed .node.active rect, 
                .dimmed .node.active circle, 
                .dimmed .node.active polygon {
                    stroke: #007acc !important;
                    stroke-width: 3px !important;
                }

                /* HINT BOX */
                .hint-box { 
                    position: absolute; bottom: 15px; right: 15px; 
                    background: rgba(30, 30, 30, 0.85); border: 1px solid #444;
                    padding: 6px 12px; font-size: 11px; color: #aaa; 
                    border-radius: 4px; pointer-events: none; z-index: 20;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <span class="title">${title}</span>
                <div class="controls">${buttons}</div>
            </div>

            <div id="graph-container">
                <div id="zoom-layer" class="mermaid">${safeGraph}</div>
            </div>
            
            <div class="hint-box">Double-click: View Detail • Wheel: Zoom • Drag: Pan</div>

            <script src="${scriptUri}"></script>
            <script>
                const vscode = acquireVsCodeApi();
                const adjacency = ${safeAdjacency};
                
                let lastClickedId = null;
                let lastClickTime = 0;

                function sendCommand(cmd, payload) { vscode.postMessage({ command: cmd, path: payload }); }
                
                function copyCode() {
                    navigator.clipboard.writeText(\`${safeGraph}\`);
                }

                // --- NODE CLICK HANDLER (Single & Double) ---
                // Called directly from Mermaid onclick binding
                window.onNodeClick = function(nodeId, filePath) {
                    const now = new Date().getTime();
                    
                    // Logic for Double Click detection
                    if (nodeId === lastClickedId && (now - lastClickTime) < 300) {
                        // ==> DOUBLE CLICK: Open File
                        sendCommand('openAndVisualize', filePath);
                        lastClickTime = 0;
                        return;
                    }
                    
                    // ==> SINGLE CLICK: Highlight Logic
                    lastClickedId = nodeId;
                    lastClickTime = now;
                    highlightNeighbors(nodeId);
                }

                // --- HIGHLIGHT LOGIC ---
                function highlightNeighbors(rootId) {
                    const container = document.getElementById('zoom-layer');
                    
                    // Reset styling
                    const allNodes = document.querySelectorAll('.node');
                    container.classList.add('dimmed');
                    allNodes.forEach(n => n.classList.remove('active'));

                    // Identify active nodes (Root + Neighbors)
                    const activeIds = [rootId];
                    if (adjacency[rootId]) {
                        activeIds.push(...adjacency[rootId]);
                    }

                    // Apply active class
                    activeIds.forEach(id => {
                        // Mermaid generates IDs like "flowchart-F1-..."
                        // We use attribute selector to find element starting with ID
                        const el = document.querySelector(\`g[id^="flowchart-\${id}-"]\`);
                        if (el) el.classList.add('active');
                    });
                }

                // Reset highlight when clicking on empty space
                document.getElementById('graph-container').addEventListener('click', (e) => {
                    if (e.target.id === 'graph-container' || e.target.id === 'zoom-layer') {
                        document.getElementById('zoom-layer').classList.remove('dimmed');
                        document.querySelectorAll('.node').classList.remove('active');
                        lastClickedId = null;
                    }
                });

                // --- MERMAID INIT ---
                mermaid.initialize({ 
                    startOnLoad: true, 
                    maxTextSize: 10000000, // Handle large graphs
                    securityLevel: 'loose',
                    theme: 'base',
                    themeVariables: { primaryColor: '#1e1e1e', lineColor: '#569cd6' },
                    flowchart: { curve: 'basis' } // Smooth curves
                });

                // --- ZOOM & PAN LOGIC (Wheel Optimized) ---
                const container = document.getElementById('graph-container');
                const layer = document.getElementById('zoom-layer');
                let scale = 1, pannedX = 0, pannedY = 0;
                let isDragging = false, startX = 0, startY = 0;

                // Zoom with Mouse Wheel (No Ctrl required)
                container.addEventListener('wheel', (e) => { 
                    e.preventDefault();
                    
                    const zoomIntensity = 0.15; // Zoom speed
                    const delta = e.deltaY > 0 ? -zoomIntensity : zoomIntensity;
                    const newScale = Math.min(Math.max(0.1, scale + delta), 10);
                    
                    // Simple center zoom calculation could be added here
                    // For now, simple scaling works well enough
                    scale = newScale;
                    updateTransform(); 
                }, { passive: false });

                // Pan Logic (Drag)
                container.addEventListener('mousedown', (e) => { 
                    isDragging = true; 
                    startX = e.clientX - pannedX; 
                    startY = e.clientY - pannedY; 
                    container.style.cursor = 'grabbing';
                });
                
                window.addEventListener('mousemove', (e) => { 
                    if (!isDragging) return; 
                    e.preventDefault(); 
                    pannedX = e.clientX - startX; 
                    pannedY = e.clientY - startY; 
                    updateTransform(); 
                });
                
                window.addEventListener('mouseup', () => { 
                    isDragging = false; 
                    container.style.cursor = 'default'; 
                });

                function updateTransform() { 
                    layer.style.transform = \`translate(\${pannedX}px, \${pannedY}px) scale(\${scale})\`; 
                }
            </script>
        </body>
        </html>`;
    }
}
