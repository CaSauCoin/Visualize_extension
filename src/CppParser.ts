import * as vscode from 'vscode';

export class CppParser {

    /**
     * Hàm chính để convert code C/C++ sang Mermaid Flowchart
     */
    public parseFlowchart(code: string): string {
        // 1. Preprocess: Xóa comment và chuẩn hóa code
        const cleanCode = this.preprocessCode(code);
        
        // 2. Split thành các dòng lệnh logic (statement-based) thay vì line-based
        // Cách đơn giản là split theo dòng mới sau khi đã clean
        const lines = cleanCode.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        let mermaid = "graph TD;\n";
        
        // --- STYLE DEFINITIONS (Màu sắc chuẩn VSCode Modern) ---
        mermaid += "classDef default fill:#1e1e1e,stroke:#cccccc,stroke-width:1px,color:#fff,rx:3px,ry:3px;\n"; // Default Node
        mermaid += "classDef decision fill:#5b2d90,stroke:#a772d0,stroke-width:2px,color:#fff,rx:5px,ry:5px;\n"; // If/Switch/Loop (Tím)
        mermaid += "classDef process fill:#005f9e,stroke:#2696d1,stroke-width:2px,color:#fff,rx:3px,ry:3px;\n";  // Normal Statement (Xanh biển)
        mermaid += "classDef terminator fill:#820808,stroke:#ff5555,stroke-width:2px,color:#fff,rx:10px,ry:10px;\n"; // Return/Throw (Đỏ)
        mermaid += "classDef switchNode fill:#9c5b0b,stroke:#e08c1d,stroke-width:2px,color:#fff,rx:5px,ry:5px;\n"; // Switch Parent (Cam)
        mermaid += "classDef catchNode fill:#946c00,stroke:#ffd700,stroke-width:2px,color:#fff,rx:5px,ry:5px;\n"; // Try/Catch (Vàng)

        let nodeIdCounter = 0;
        let stack: string[] = ["Start"]; // Stack quản lý node cha để nối dây
        let switchStack: { id: string, hasDefault: boolean }[] = []; // Stack quản lý Switch
        let ignoreBlockLevel = 0; // Biến đếm để bỏ qua block struct/class/enum

        mermaid += `Start((START)) --> Node0;\n`;

        for (let i = 0; i < lines.length; i++) {
            let text = lines[i];

            // --- BỎ QUA CÁC CẤU TRÚC DỮ LIỆU & MACRO ---
            // Nếu gặp struct/class/enum/union/namespace -> Tăng cờ ignore
            if (text.match(/^(struct|class|enum|union|namespace)\s+/)) {
                if (text.includes('{')) ignoreBlockLevel++;
                continue; // Không vẽ
            }
            if (text.startsWith('#') || text.startsWith('using namespace') || text.startsWith('template')) continue;

            // Xử lý block scope { }
            if (text.includes('{') && !text.includes('}')) {
                // Nếu đang trong mode ignore, tăng level
                if (ignoreBlockLevel > 0) {
                    ignoreBlockLevel++;
                    continue;
                }
                // Nếu dòng chỉ có {, bỏ qua (nhưng logic if/else đã handle push stack rồi)
                if (text === '{') continue;
            }

            if (text.includes('}')) {
                if (ignoreBlockLevel > 0) {
                    ignoreBlockLevel--;
                    continue;
                }
                // Kết thúc block -> Pop stack để quay về luồng cha
                if (stack.length > 1) {
                    // Check xem có phải đang đóng switch không
                    if (switchStack.length > 0 && stack[stack.length - 1] === switchStack[switchStack.length - 1].id) {
                        switchStack.pop();
                    }
                    stack.pop();
                }
                if (text === '}' || text === '};') continue;
            }

            // Nếu vẫn đang trong struct/class -> Bỏ qua mọi dòng bên trong
            if (ignoreBlockLevel > 0) continue;

            // --- XỬ LÝ LOGIC NODE ---
            const currentId = `Node${nodeIdCounter++}`;
            const parentId = stack[stack.length - 1];
            let displayLabel = this.cleanLabel(text);

            // 1. IF / ELSE IF
            if (text.startsWith('if') || text.startsWith('else if')) {
                const condition = this.extractCondition(displayLabel, 'if');
                mermaid += `${currentId}{"${condition} ?"}:::decision;\n`;
                mermaid += `${parentId} --> ${currentId};\n`;
                stack.push(currentId); // Các lệnh con sẽ nối từ if
            }
            // 2. ELSE
            else if (text.startsWith('else')) {
                if (stack.length > 1) stack.pop(); // Thoát khỏi nhánh if trước đó
                // Tạo node ảo hoặc nối trực tiếp
                mermaid += `${currentId}["else"]:::default;\n`;
                // Nối từ cha của if (cái này hơi tricky trong static analysis, ta nối tạm từ node trước đó)
                // Trong thực tế cần AST để nối đúng luồng False của If.
                // Ở đây ta dùng thủ thuật nối tiếp.
                if (stack.length > 0) mermaid += `${stack[stack.length - 1]} --> ${currentId};\n`;
                stack.push(currentId);
            }
            // 3. SWITCH
            else if (text.startsWith('switch')) {
                const condition = this.extractCondition(displayLabel, 'switch');
                mermaid += `${currentId}{"Switch: ${condition}"}:::switchNode;\n`;
                mermaid += `${parentId} --> ${currentId};\n`;
                stack.push(currentId);
                switchStack.push({ id: currentId, hasDefault: false });
            }
            // 4. CASE / DEFAULT
            else if (text.startsWith('case') || text.startsWith('default')) {
                // Case nối từ Switch Parent, KHÔNG PHẢI từ case trước (trừ khi fallthrough - nhưng ta vẽ đơn giản)
                const switchNode = switchStack.length > 0 ? switchStack[switchStack.length - 1].id : parentId;
                
                // Format label: "case 1:" -> "Case 1"
                let caseLabel = displayLabel.replace(':', '');
                mermaid += `${currentId}["${caseLabel}"]:::decision;\n`;
                mermaid += `${switchNode} -- ${caseLabel} --> ${currentId};\n`;
                
                // Update parent hiện tại thành case này để các lệnh sau nối vào
                // Lưu ý: Không push stack mới vì case không mở block scope {} bắt buộc
                if (stack.length > 0) stack[stack.length - 1] = currentId;
            }
            // 5. LOOPS (While / For)
            else if (text.startsWith('while') || text.startsWith('for')) {
                const type = text.startsWith('while') ? 'while' : 'for';
                const condition = this.extractCondition(displayLabel, type);
                mermaid += `${currentId}{"${type}: ${condition}"}:::decision;\n`;
                mermaid += `${parentId} --> ${currentId};\n`;
                // Loopback logic (đơn giản hóa): Node con sẽ nối vào đây
                stack.push(currentId);
            }
            // 6. DO ... WHILE
            else if (text.startsWith('do')) {
                mermaid += `${currentId}("DO loop start"):::decision;\n`;
                mermaid += `${parentId} --> ${currentId};\n`;
                stack.push(currentId);
            }
            // 7. TRY / CATCH
            else if (text.startsWith('try')) {
                mermaid += `${currentId}<"TRY Block">:::catchNode;\n`;
                mermaid += `${parentId} --> ${currentId};\n`;
                stack.push(currentId);
            }
            else if (text.startsWith('catch')) {
                if (stack.length > 1) stack.pop(); // End try
                const condition = this.extractCondition(displayLabel, 'catch');
                mermaid += `${currentId}<"CATCH: ${condition}">:::catchNode;\n`;
                // Nối từ đâu? Thường là từ khối try (nhưng static parser khó biết), ta nối tiếp luồng
                if (stack.length > 0) mermaid += `${stack[stack.length - 1]} -.-> ${currentId};\n`; // Nét đứt cho exception
                stack.push(currentId);
            }
            // 8. JUMPS (Return / Break / Continue / Goto / Throw)
            else if (text.match(/^(return|break|continue|goto|throw)/)) {
                mermaid += `${currentId}(("${displayLabel}")):::terminator;\n`;
                mermaid += `${parentId} --> ${currentId};\n`;
                // Không push stack vì luồng kết thúc tại đây (hoặc nhảy đi)
            }
            // 9. NORMAL STATEMENT
            else {
                // Phân loại: Hàm hay lệnh gán?
                const typeClass = text.includes('(') ? 'process' : 'default';
                mermaid += `${currentId}["${displayLabel}"]:::${typeClass};\n`;
                mermaid += `${parentId} --> ${currentId};\n`;
                
                // Node này trở thành cha của node tiếp theo
                if (stack.length > 0) stack[stack.length - 1] = currentId;
            }
        }

        return mermaid;
    }

    /**
     * Làm sạch code:
     * 1. Xóa comment /* ... *\/ và //
     * 2. Xóa khoảng trắng thừa
     * 3. Gộp các dòng code bị ngắt quãng (VD: if (...) \n { )
     */
    private preprocessCode(code: string): string {
        // 1. Remove Block Comments /* ... */
        let noBlockComments = code.replace(/\/\*[\s\S]*?\*\//g, '');
        
        // 2. Remove Line Comments // (Cẩn thận không xóa // trong string "http://")
        // Cách đơn giản: split theo dòng, xóa từ // trở đi (nếu // không nằm trong quote)
        // Regex đơn giản hóa:
        let lines = noBlockComments.split('\n');
        let cleanLines = lines.map(line => {
            const idx = line.indexOf('//');
            if (idx !== -1) return line.substring(0, idx);
            return line;
        });

        // 3. Trim và loại bỏ dòng trống
        return cleanLines.map(l => l.trim()).filter(l => l).join('\n');
    }

    /**
     * Làm sạch nhãn hiển thị cho Mermaid
     * (Escape ký tự đặc biệt, cắt ngắn)
     */
    private cleanLabel(text: string): string {
        // Thay thế ngoặc kép " thành ngoặc đơn '
        let safeText = text.replace(/"/g, "'");
        
        // Thay thế các ký tự làm hỏng syntax Mermaid: (), [], {}
        // Ta chỉ giữ lại () nếu nó là hàm gọi, còn [] {} thì thay bằng khoảng trắng
        safeText = safeText.replace(/[\[\]\{\}]/g, " ");
        
        // Escape HTML entities
        safeText = safeText
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        // Cắt ngắn nếu quá dài
        if (safeText.length > 50) {
            return safeText.substring(0, 47) + "...";
        }
        return safeText;
    }

    /**
     * Trích xuất điều kiện trong ngoặc. VD: if (a > b) -> a > b
     */
    private extractCondition(text: string, keyword: string): string {
        // Regex tìm nội dung trong ngoặc đơn đầu tiên sau keyword
        // VD: if  ( x > 0 ) -> match: x > 0
        const regex = new RegExp(`${keyword}\\s*\\((.*)\\)`);
        const match = text.match(regex);
        if (match && match[1]) {
            let cond = match[1];
            // Nếu cuối chuỗi còn dính dấu ) thừa (do replace simple)
            if (cond.endsWith(')')) cond = cond.slice(0, -1);
            return cond.trim();
        }
        // Fallback: Xóa keyword và trả về text
        return text.replace(keyword, '').replace(/[()]/g, '').trim();
    }
}
