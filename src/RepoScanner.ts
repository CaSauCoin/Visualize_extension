import * as vscode from 'vscode';
import * as path from 'path';

// Return type
export interface GraphResult {
    mermaid: string;
    adjacency: Record<string, string[]>; // Map: NodeID -> [NeighborID1, NeighborID2...]
}

export class RepoScanner {
    
    private IGNORE_FOLDERS = [
        'build', 'out', 'dist', 'node_modules', 'external', 
        'cmake-build-debug', 'cmake-build-release', '.git', '.vscode'
    ];

    public async getProjectFolders(): Promise<string[]> {
        const files = await vscode.workspace.findFiles('**/*.{c,cpp,h,hpp,cc,hh,cxx,hxx}');
        const folders = new Set<string>();
        for (const file of files) {
            const pathStr = file.fsPath.replace(/\\/g, '/');
            if (this.IGNORE_FOLDERS.some(folder => pathStr.includes(`/${folder}/`))) continue;
            const dir = path.dirname(file.fsPath);
            const relativeDir = vscode.workspace.asRelativePath(dir);
            folders.add(relativeDir === '.' ? 'Root' : relativeDir);
        }
        return Array.from(folders).sort();
    }

    // Update: Return GraphResult (mermaid + adjacency)
    public async generateDependencyGraph(allowedFolders: string[] | null = null): Promise<GraphResult> {
        const files = await vscode.workspace.findFiles('**/*.{c,cpp,h,hpp,cc,hh,cxx,hxx}');
        
        const pathToId = new Map<string, string>();
        const idToPath = new Map<string, string>();
        let idCounter = 0;
        const validFiles: vscode.Uri[] = [];

        // 1. Filter Files & Create IDs
        for (const file of files) {
            const pathStr = file.fsPath.replace(/\\/g, '/');
            if (this.IGNORE_FOLDERS.some(folder => pathStr.includes(`/${folder}/`))) continue;

            if (allowedFolders && allowedFolders.length > 0) {
                const dir = path.dirname(file.fsPath);
                const relativeDir = vscode.workspace.asRelativePath(dir);
                const checkDir = relativeDir === '.' ? 'Root' : relativeDir;
                const isSelected = allowedFolders.some(allowed => 
                    checkDir === allowed || checkDir.startsWith(allowed + '/')
                );
                if (!isSelected) continue;
            }

            const id = `F${idCounter++}`;
            pathToId.set(file.fsPath, id);
            idToPath.set(id, file.fsPath);
            validFiles.push(file);
        }

        // 2. Build edges & adjacency list
        const edges: { from: string, to: string }[] = [];
        const nodeDegrees = new Map<string, number>();
        // Neighbor list to send down to the Webview
        const adjacency: Record<string, string[]> = {}; 

        for (const file of validFiles) {
            const sourceId = pathToId.get(file.fsPath)!;
            if (!nodeDegrees.has(sourceId)) nodeDegrees.set(sourceId, 0);
            if (!adjacency[sourceId]) adjacency[sourceId] = [];

            try {
                const doc = await vscode.workspace.openTextDocument(file);
                const content = doc.getText();
                const includeRegex = /#include\s*["<]([^">]+)[">]/g;
                let match;

                while ((match = includeRegex.exec(content)) !== null) {
                    const includedName = match[1];
                    const targetEntry = Array.from(pathToId.entries()).find(([p, id]) => {
                        return p.replace(/\\/g, '/').endsWith(includedName);
                    });

                    if (targetEntry) {
                        const targetId = targetEntry[1];
                        if (sourceId !== targetId) {
                            edges.push({ from: sourceId, to: targetId });
                            
                            // Update Degrees
                            nodeDegrees.set(sourceId, (nodeDegrees.get(sourceId) || 0) + 1);
                            nodeDegrees.set(targetId, (nodeDegrees.get(targetId) || 0) + 1);

                            // Update adjacency (store both directions for easier highlighting)
                            if (!adjacency[sourceId].includes(targetId)) adjacency[sourceId].push(targetId);
                            if (!adjacency[targetId]) adjacency[targetId] = [];
                            if (!adjacency[targetId].includes(sourceId)) adjacency[targetId].push(sourceId);
                        }
                    }
                }
            } catch (e) {}
        }

        // 3. Generate Mermaid
        let mermaid = "graph LR;\n";
        mermaid += "classDef file fill:#2d2d2d,stroke:#569cd6,stroke-width:2px,color:#fff;\n";
        mermaid += "classDef folder fill:#1e1e1e,stroke:#444,stroke-width:2px,color:#aaa,stroke-dasharray: 5 5;\n";
        mermaid += "classDef faded opacity:0.1,stroke:#444;\n"; // Class used to fade nodes

        const folderGroups = new Map<string, string[]>();

        for (const file of validFiles) {
            const fileId = pathToId.get(file.fsPath)!;
            if ((nodeDegrees.get(fileId) || 0) === 0) continue;

            const dir = path.dirname(file.fsPath);
            const relativeDir = vscode.workspace.asRelativePath(dir);
            if (!folderGroups.has(relativeDir)) folderGroups.set(relativeDir, []);
            folderGroups.get(relativeDir)?.push(fileId);
        }

        let groupCounter = 0;
        for (const [folderName, fileIds] of folderGroups) {
            if (fileIds.length === 0) continue;
            const shortName = folderName === '.' ? 'Root' : folderName.split('/').pop() || folderName;
            mermaid += `subgraph G${groupCounter++} ["📁 ${shortName}"]\n`;
            mermaid += `direction TB;\n`;
            for (const fileId of fileIds) {
                const fullPath = idToPath.get(fileId)!;
                const fileName = path.basename(fullPath);
                mermaid += `${fileId}["${fileName}"]:::file;\n`;
            }
            mermaid += `end\n`;
        }

        for (const edge of edges) {
            const isSourceVisible = (nodeDegrees.get(edge.from) || 0) > 0;
            const isTargetVisible = (nodeDegrees.get(edge.to) || 0) > 0;
            if (isSourceVisible && isTargetVisible) {
                mermaid += `${edge.from} --> ${edge.to};\n`;
            }
        }

        // Important: include node ID (F1, F2...) in the click handler so the Webview knows which node was clicked
        for (const [id, fullPath] of idToPath) {
             if ((nodeDegrees.get(id) || 0) > 0) {
                 const safePath = fullPath.replace(/\\/g, '/');
                 // Signature: onNodeClick(NodeID, FilePath)
                 mermaid += `click ${id} call onNodeClick("${id}", "${safePath}");\n`;
             }
        }
        
        return { mermaid, adjacency };
    }
}
