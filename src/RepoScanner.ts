import * as vscode from 'vscode';
import * as path from 'path';

export interface GraphResult {
    mermaid: string;
    adjacency: Record<string, string[]>;
}

export class RepoScanner {
    
    private IGNORE_FOLDERS = [
        'build', 'out', 'dist', 'node_modules', 'external', 
        'cmake-build-debug', 'cmake-build-release', '.git', '.vscode'
    ];

    public async getProjectFolders(): Promise<string[]> {
        // Hỗ trợ cả C và C++
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

    public async generateDependencyGraph(allowedFolders: string[] | null = null): Promise<GraphResult> {
        // 1. Quét file
        const files = await vscode.workspace.findFiles('**/*.{c,cpp,h,hpp,cc,hh,cxx,hxx}');
        
        const pathToId = new Map<string, string>();
        const idToPath = new Map<string, string>();
        let idCounter = 0;
        const validFiles: vscode.Uri[] = [];

        // Kiểm tra xem có đang ở chế độ Filter không
        const isFilterMode = allowedFolders !== null && allowedFolders.length > 0;

        // 2. Lọc File hợp lệ & Tạo ID
        for (const file of files) {
            const pathStr = file.fsPath.replace(/\\/g, '/');
            if (this.IGNORE_FOLDERS.some(folder => pathStr.includes(`/${folder}/`))) continue;

            // Logic lọc theo folder người dùng chọn
            if (isFilterMode) {
                const dir = path.dirname(file.fsPath);
                const relativeDir = vscode.workspace.asRelativePath(dir);
                const checkDir = relativeDir === '.' ? 'Root' : relativeDir;
                
                // File phải nằm trong folder được chọn (hoặc con của nó)
                const isSelected = allowedFolders!.some(allowed => 
                    checkDir === allowed || checkDir.startsWith(allowed + '/')
                );
                
                if (!isSelected) continue;
            }

            const id = `F${idCounter++}`;
            pathToId.set(file.fsPath, id);
            idToPath.set(id, file.fsPath);
            validFiles.push(file);
        }

        // 3. Xây dựng kết nối (Edges)
        const edges: { from: string, to: string }[] = [];
        const nodeDegrees = new Map<string, number>();
        const adjacency: Record<string, string[]> = {}; 

        for (const file of validFiles) {
            const sourceId = pathToId.get(file.fsPath)!;
            
            // Init data
            if (!nodeDegrees.has(sourceId)) nodeDegrees.set(sourceId, 0);
            if (!adjacency[sourceId]) adjacency[sourceId] = [];

            try {
                const doc = await vscode.workspace.openTextDocument(file);
                const content = doc.getText();
                // Regex tìm #include
                const includeRegex = /#include\s*["<]([^">]+)[">]/g;
                let match;

                while ((match = includeRegex.exec(content)) !== null) {
                    const includedName = match[1];
                    // Chỉ link tới các file CŨNG NẰM TRONG danh sách validFiles
                    const targetEntry = Array.from(pathToId.entries()).find(([p, id]) => {
                        return p.replace(/\\/g, '/').endsWith(includedName);
                    });

                    if (targetEntry) {
                        const targetId = targetEntry[1];
                        if (sourceId !== targetId) {
                            edges.push({ from: sourceId, to: targetId });
                            
                            // Tăng biến đếm kết nối
                            nodeDegrees.set(sourceId, (nodeDegrees.get(sourceId) || 0) + 1);
                            nodeDegrees.set(targetId, (nodeDegrees.get(targetId) || 0) + 1);

                            // Adjacency cho highlight
                            if (!adjacency[sourceId].includes(targetId)) adjacency[sourceId].push(targetId);
                            // 2 chiều (để click con sáng cha)
                            if (!adjacency[targetId]) adjacency[targetId] = [];
                            if (!adjacency[targetId].includes(sourceId)) adjacency[targetId].push(sourceId);
                        }
                    }
                }
            } catch (e) {}
        }

        // 4. Generate Mermaid
        let mermaid = "graph LR;\n";
        mermaid += "classDef file fill:#2d2d2d,stroke:#569cd6,stroke-width:2px,color:#fff;\n";
        mermaid += "classDef folder fill:#1e1e1e,stroke:#444,stroke-width:2px,color:#aaa,stroke-dasharray: 5 5;\n";

        const folderGroups = new Map<string, string[]>();

        for (const file of validFiles) {
            const fileId = pathToId.get(file.fsPath)!;
            
            // Nếu đang Filter Mode (isFilterMode = true) -> HIỆN TẤT CẢ (Không check degree)
            // Nếu đang Full Scan (isFilterMode = false) -> Chỉ hiện node có kết nối (Check degree > 0) để giảm tải
            if (!isFilterMode && (nodeDegrees.get(fileId) || 0) === 0) {
                continue; 
            }

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
            // Chỉ vẽ edge nếu cả 2 đầu đều được hiển thị
            // (Trong Filter Mode thì luôn hiển thị nên luôn vẽ)
            // (Trong Full Mode thì check degree > 0 mới vẽ)
            const showSource = isFilterMode || (nodeDegrees.get(edge.from) || 0) > 0;
            const showTarget = isFilterMode || (nodeDegrees.get(edge.to) || 0) > 0;

            if (showSource && showTarget) {
                mermaid += `${edge.from} --> ${edge.to};\n`;
            }
        }

        // Add Click Events
        for (const [id, fullPath] of idToPath) {
             // Tương tự: Filter Mode thì add click hết
             const showNode = isFilterMode || (nodeDegrees.get(id) || 0) > 0;
             if (showNode) {
                 const safePath = fullPath.replace(/\\/g, '/');
                 mermaid += `click ${id} call onNodeClick("${id}", "${safePath}");\n`;
             }
        }
        
        return { mermaid, adjacency };
    }
}