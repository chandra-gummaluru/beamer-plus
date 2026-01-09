export class Canvas {
    constructor(container, drawable=true) {
        if (!container) throw new Error("Container element is required");

        this.canvas = document.createElement('canvas');
        
        // High-DPI canvas setup
        const dpr = window.devicePixelRatio || 1;
        const rect = container.getBoundingClientRect();
        
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
        
        this.pointer_mode = 'hand';
        container.appendChild(this.canvas);

        // Ensure clicks pass through when in hand mode by default
        if (this.pointer_mode === 'hand') {
            this.canvas.style.pointerEvents = 'none';
        }

        this.ctx = this.canvas.getContext('2d');
        this.ctx.scale(dpr, dpr);
        
        // Enable smoothing
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';

        this.buffer = document.createElement("canvas");
        this.bufferCtx = this.buffer.getContext("2d");
        
        // Temporary canvas for drawing current stroke (for proper alpha blending)
        this.strokeBuffer = document.createElement("canvas");
        this.strokeBufferCtx = this.strokeBuffer.getContext("2d");

        this.drawing = false;
        this.currentStroke = null;
        this.strokeColor = 'black'
        this.strokeWidth = 2
        this.dpr = dpr;
        
        // E-ink optimization: detect and adjust
        this.isEink = this.detectEink();
        this.minPointDistance = this.isEink ? 5 : 1; // Skip more points on e-ink
        this.lastDrawTime = 0;
        this.drawThrottle = this.isEink ? 100 : 0; // Throttle drawing on e-ink

        this.history = [];
        this.redoStack = [];
        this.maxHistory = 50;
        this.historyChangeHandler = null;
        this.shapeLock = null;
        this.shapeLockTimer = null;
        this.shapeLockDelay = 2000;
        this.lastMoveTime = 0;
        this.lastMovePoint = null;
        this.savedCanvasState = null;

        this.setupEvents(drawable);
        this.commitHistory();
    }
    
    detectEink() {
        // Heuristic: e-ink devices typically have very low color depth
        // and specific user agents, but we'll use a simple detection
        // You can also add a manual toggle if needed
        const colorDepth = window.screen.colorDepth;
        const userAgent = navigator.userAgent.toLowerCase();
        
        // Check for known e-ink devices
        if (userAgent.includes('kindle') || 
            userAgent.includes('kobo') || 
            userAgent.includes('remarkable')) {
            return true;
        }
        
        // Low color depth might indicate e-ink
        if (colorDepth <= 8) {
            return true;
        }
        
        return false;
    }

    setPointerMode(pointer_mode) {
        this.pointer_mode = pointer_mode;
        
        // When in hand mode, let clicks pass through to videos/models underneath
        if (pointer_mode === 'hand') {
            this.canvas.style.pointerEvents = 'none';
        } else {
            this.canvas.style.pointerEvents = 'auto';
        }
    }

    setupEvents(drawable) {
        if (drawable) {
            this.canvas.addEventListener('mousedown', e => this.startDraw(e));
            this.canvas.addEventListener('mousemove', e => this.draw(e));
            this.canvas.addEventListener('mouseup', e => this.stopDraw(e));
            this.canvas.addEventListener('mouseleave', e => this.stopDraw(e));

            this.canvas.addEventListener('touchstart', e => this.startDraw(e), { passive: false });
            this.canvas.addEventListener('touchmove', e => this.draw(e), { passive: false });
            this.canvas.addEventListener('touchend', e => this.stopDraw(e), { passive: false });
        }
    }

    getPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        if (e.touches) {
            return { 
                x: e.touches[0].clientX - rect.left, 
                y: e.touches[0].clientY - rect.top 
            };
        }
        return { 
            x: e.clientX - rect.left, 
            y: e.clientY - rect.top 
        };
    }

    setStrokeColor(strokeColor) {
        this.strokeColor = strokeColor
    }
    
    setStrokeWidth(strokeWidth) {
        this.strokeWidth = strokeWidth
    }

    setHistoryChangeHandler(fn) {
        this.historyChangeHandler = fn;
        this.notifyHistoryChange();
    }

    notifyHistoryChange() {
        if (this.historyChangeHandler) {
            this.historyChangeHandler({
                canUndo: this.canUndo(),
                canRedo: this.canRedo()
            });
        }
    }

    getSnapshot() {
        return this.canvas.toDataURL("image/png");
    }

    commitHistory() {
        const snapshot = this.getSnapshot();
        const last = this.history[this.history.length - 1];
        if (snapshot === last) return;

        this.history.push(snapshot);
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }
        this.redoStack = [];
        this.notifyHistoryChange();
    }

    resetHistory(dataURL) {
        const snapshot = dataURL || this.getSnapshot();
        this.history = [snapshot];
        this.redoStack = [];
        this.notifyHistoryChange();
    }

    canUndo() {
        return this.history.length > 1;
    }

    canRedo() {
        return this.redoStack.length > 0;
    }

    async applySnapshot(dataURL) {
        if (!dataURL) {
            this.clear();
            return;
        }

        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                try {
                    this.ctx.globalCompositeOperation = "source-over";
                    this.ctx.globalAlpha = 1;
                    this.clear();
                    const dw = this.canvas.width / this.dpr;
                    const dh = this.canvas.height / this.dpr;
                    this.ctx.drawImage(img, 0, 0, dw, dh);
                } catch (e) {
                    console.error('Error drawing annotations image:', e);
                }
                resolve();
            };
            img.onerror = () => {
                this.clear();
                resolve();
            };
            img.src = dataURL;
        });
    }

    async undo() {
        if (!this.canUndo()) return;
        const current = this.history.pop();
        this.redoStack.push(current);
        const previous = this.history[this.history.length - 1];
        await this.applySnapshot(previous);
        this.notifyHistoryChange();
    }

    async redo() {
        if (!this.canRedo()) return;
        const next = this.redoStack.pop();
        this.history.push(next);
        await this.applySnapshot(next);
        this.notifyHistoryChange();
    }

    startDraw(e) {
        if (this.pointer_mode === "hand") {
            return;
        }

        e.preventDefault();
        this.drawing = true;
        this.shapeLock = null;
        if (this.shapeLockTimer) {
            clearTimeout(this.shapeLockTimer);
            this.shapeLockTimer = null;
        }
        this.savedCanvasState = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

        const ctx = this.ctx;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        const p = this.getPos(e);
        this.lastMoveTime = Date.now();
        this.lastMovePoint = p;

        let color = this.strokeColor;
        let width = this.strokeWidth;
        let mode = this.pointer_mode;

        switch (this.pointer_mode) {
            case "draw":
                this.ctx.globalAlpha = 1;
                this.ctx.globalCompositeOperation = "source-over";
                break;

            case "highlight":
                // For highlighter, setup a stroke buffer
                const rect = this.canvas.getBoundingClientRect();
                this.strokeBuffer.width = rect.width * this.dpr;
                this.strokeBuffer.height = rect.height * this.dpr;
                
                // Get a fresh context after resizing
                this.strokeBufferCtx = this.strokeBuffer.getContext("2d");
                this.strokeBufferCtx.scale(this.dpr, this.dpr);
                this.strokeBufferCtx.lineCap = 'round';
                this.strokeBufferCtx.lineJoin = 'round';
                this.strokeBufferCtx.imageSmoothingEnabled = true;
                this.strokeBufferCtx.imageSmoothingQuality = 'high';
                
                // Draw with full opacity on buffer
                this.strokeBufferCtx.globalAlpha = 1;
                this.strokeBufferCtx.globalCompositeOperation = "source-over";
                
                // Save the current canvas state
                this.savedCanvasState = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
                
                width = this.strokeWidth * 8;
                break;

            case "erase":
                this.ctx.globalCompositeOperation = "destination-out";
                this.ctx.globalAlpha = 1;
                width = this.strokeWidth * 12;
                color = "white";
                break;
        }

        this.currentStroke = {
            points: [p],
            color,
            width,
            mode
        };
    }

    draw(e) {
        if (this.pointer_mode === "hand") {
            return;
        }

        if (!this.drawing) return;
        e.preventDefault();
        
        // Throttle drawing updates for e-ink
        const now = Date.now();
        if (this.isEink && now - this.lastDrawTime < this.drawThrottle) {
            return;
        }
        this.lastDrawTime = now;
        
        const p = this.getPos(e);
        const pts = this.currentStroke.points;
        
        // Skip if point is too close to last point (reduces jitter)
        if (pts.length > 0) {
            const lastPt = pts[pts.length - 1];
            const dist = Math.sqrt(Math.pow(p.x - lastPt.x, 2) + Math.pow(p.y - lastPt.y, 2));
            if (dist < this.minPointDistance) return; // Skip points that are too close
        }
        
        pts.push(p);

        if (!this.shapeLock) {
            this.lastMoveTime = now;
            this.lastMovePoint = p;
            if (this.shapeLockTimer) {
                clearTimeout(this.shapeLockTimer);
            }
            this.shapeLockTimer = setTimeout(() => this.tryLockShape(), this.shapeLockDelay);
        }

        if (this.shapeLock) {
            this.drawLockedShape(p);
            return;
        }

        // Use stroke buffer for highlighter, main context for others
        const ctx = this.currentStroke.mode === 'highlight' ? this.strokeBufferCtx : this.ctx;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = this.currentStroke.color;
        ctx.lineWidth = this.currentStroke.width;
        
        // For e-ink: use simpler straight lines for preview
        if (this.isEink) {
            if (pts.length >= 2) {
                ctx.beginPath();
                const p1 = pts[pts.length - 2];
                const p2 = pts[pts.length - 1];
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.stroke();
            }
        } else {
            // Regular smooth curves for normal displays
            if (pts.length > 3) {
                ctx.beginPath();
                const p0 = pts[pts.length - 4];
                const p1 = pts[pts.length - 3];
                const p2 = pts[pts.length - 2];
                const p3 = pts[pts.length - 1];
                
                // Catmull-Rom to Bezier conversion
                const cp1x = p1.x + (p2.x - p0.x) / 6;
                const cp1y = p1.y + (p2.y - p0.y) / 6;
                const cp2x = p2.x - (p3.x - p1.x) / 6;
                const cp2y = p2.y - (p3.y - p1.y) / 6;
                
                ctx.moveTo(p1.x, p1.y);
                ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
                ctx.stroke();
            } else if (pts.length === 2) {
                // First segment - simple line
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
            } else if (pts.length === 3) {
                // Second segment - quadratic curve
                ctx.beginPath();
                const p0 = pts[0];
                const p1 = pts[1];
                const p2 = pts[2];
                const midX = (p1.x + p2.x) / 2;
                const midY = (p1.y + p2.y) / 2;
                ctx.moveTo(p0.x, p0.y);
                ctx.quadraticCurveTo(p1.x, p1.y, midX, midY);
                ctx.stroke();
            }
        }
        
        // For highlighter, composite the buffer to main canvas in real-time
        if (this.currentStroke.mode === 'highlight') {
            // Restore the saved state
            this.ctx.putImageData(this.savedCanvasState, 0, 0);
            
            // Composite the stroke buffer with proper alpha
            this.ctx.save();
            this.ctx.globalAlpha = 0.4;
            this.ctx.globalCompositeOperation = "multiply";
            
            const rect = this.canvas.getBoundingClientRect();
            this.ctx.drawImage(this.strokeBuffer, 0, 0, rect.width, rect.height);
            
            this.ctx.restore();
        }
    }

    stopDraw(e) {
        if (this.pointer_mode === "hand") {
            return;
        }

        if (!this.drawing) return;
        e.preventDefault();
        if (this.shapeLockTimer) {
            clearTimeout(this.shapeLockTimer);
            this.shapeLockTimer = null;
        }
        
        // For highlighter, finalize the composite
        if (this.currentStroke && this.currentStroke.mode === 'highlight') {
            // Restore the saved canvas state
            this.ctx.putImageData(this.savedCanvasState, 0, 0);
            
            // Composite the final stroke buffer with proper alpha
            this.ctx.save();
            this.ctx.globalAlpha = 0.4;
            this.ctx.globalCompositeOperation = "multiply";
            
            const rect = this.canvas.getBoundingClientRect();
            this.ctx.drawImage(this.strokeBuffer, 0, 0, rect.width, rect.height);
            
            this.ctx.restore();
            
            // Clear the stroke buffer and saved state
            this.strokeBufferCtx.clearRect(0, 0, this.strokeBuffer.width, this.strokeBuffer.height);
            this.savedCanvasState = null;
        }
        
        // For e-ink: redraw the entire stroke smoothly when pen lifts
        // This creates a cleaner final result
        if (this.isEink && this.currentStroke && this.currentStroke.points.length > 2) {
            this.redrawStrokeSmooth(this.currentStroke);
        }
        
        this.drawing = false;
        this.currentStroke = null;
        this.ctx.globalCompositeOperation = "source-over";
        this.ctx.globalAlpha = 1;
        this.savedCanvasState = null;
        this.commitHistory();
    }

    tryLockShape() {
        this.shapeLockTimer = null;
        if (this.shapeLock || !this.drawing || !this.currentStroke) return;
        if (Date.now() - this.lastMoveTime < this.shapeLockDelay) return;

        const pts = this.currentStroke.points || [];
        if (pts.length < 10) return;

        const lockedType = this.detectShape(pts);
        if (!lockedType) return;

        const lockPoint = this.lastMovePoint || pts[pts.length - 1];
        this.shapeLock = this.getLockedShapeData(lockedType, pts, lockPoint);
        if (!this.savedCanvasState) {
            this.savedCanvasState = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        }
        this.drawLockedShape(lockPoint);
    }

    getLockedShapeData(type, points, center) {
        const bbox = this.getBoundingBox(points);
        const width = bbox.maxX - bbox.minX;
        const height = bbox.maxY - bbox.minY;
        const shape = {
            type,
            center,
            width,
            height
        };

        if (type === 'line') {
            let dx = points[points.length - 1].x - points[0].x;
            let dy = points[points.length - 1].y - points[0].y;
            let norm = Math.sqrt(dx * dx + dy * dy);
            if (norm < 1) {
                dx = 1;
                dy = 0;
                norm = 1;
            }
            const length = Math.max(norm, Math.max(width, height));
            shape.line = {
                dx: dx / norm,
                dy: dy / norm,
                length
            };
        }

        return shape;
    }
    
    redrawStrokeSmooth(stroke) {
        // Clear and redraw the stroke with better smoothing
        // This happens only once when the pen lifts, so it's acceptable on e-ink
        const ctx = this.ctx;
        const pts = stroke.points;
        
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        
        // Draw a simplified smooth path through all points
        if (pts.length < 3) return;
        
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        
        // Use quadratic curves for smoothing (simpler than Bezier)
        for (let i = 1; i < pts.length - 1; i++) {
            const xc = (pts[i].x + pts[i + 1].x) / 2;
            const yc = (pts[i].y + pts[i + 1].y) / 2;
            ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
        }
        
        // Draw final point
        const lastPt = pts[pts.length - 1];
        ctx.lineTo(lastPt.x, lastPt.y);
        ctx.stroke();
    }

    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
    }

    clearAndCommit() {
        this.clear();
        this.commitHistory();
    }

    // Load annotations from a data URL (image) and draw onto the canvas
    async loadAnnotations(dataURL) {
        await this.applySnapshot(dataURL);
        this.resetHistory(dataURL);
    }

    drawLockedShape(p) {
        const mode = this.currentStroke.mode;
        const shape = this.shapeLock;
        const rect = this.canvas.getBoundingClientRect();
        const ctx = mode === 'highlight' ? this.strokeBufferCtx : this.ctx;

        if (mode === 'highlight') {
            this.ctx.putImageData(this.savedCanvasState, 0, 0);
            this.strokeBufferCtx.clearRect(0, 0, this.strokeBuffer.width, this.strokeBuffer.height);
        } else if (this.savedCanvasState) {
            this.ctx.putImageData(this.savedCanvasState, 0, 0);
        }

        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = this.currentStroke.color;
        ctx.lineWidth = this.currentStroke.width;
        ctx.globalAlpha = 1;
        if (mode === 'erase') {
            ctx.globalCompositeOperation = "destination-out";
        } else {
            ctx.globalCompositeOperation = "source-over";
        }

        this.renderLockedShape(ctx, shape);

        if (mode === 'highlight') {
            this.ctx.save();
            this.ctx.globalAlpha = 0.4;
            this.ctx.globalCompositeOperation = "multiply";
            this.ctx.drawImage(this.strokeBuffer, 0, 0, rect.width, rect.height);
            this.ctx.restore();
        }
    }

    renderLockedShape(ctx, shape) {
        const type = shape.type;
        const center = shape.center;
        const width = shape.width;
        const height = shape.height;
        ctx.beginPath();
        if (type === 'line') {
            const half = (shape.line ? shape.line.length : Math.max(width, height)) / 2;
            const dx = (shape.line ? shape.line.dx : 1) * half;
            const dy = (shape.line ? shape.line.dy : 0) * half;
            ctx.moveTo(center.x - dx, center.y - dy);
            ctx.lineTo(center.x + dx, center.y + dy);
        } else if (type === 'rectangle') {
            ctx.strokeRect(center.x - width / 2, center.y - height / 2, width, height);
            return;
        } else if (type === 'circle') {
            const radius = Math.max(width, height) / 2;
            ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        } else if (type === 'triangle') {
            const left = center.x - width / 2;
            const right = center.x + width / 2;
            const top = center.y - height / 2;
            const bottom = center.y + height / 2;
            const apex = { x: center.x, y: top };
            ctx.moveTo(apex.x, apex.y);
            ctx.lineTo(right, bottom);
            ctx.lineTo(left, bottom);
            ctx.closePath();
        }
        ctx.stroke();
    }

    detectShape(points) {
        const bbox = this.getBoundingBox(points);
        const width = bbox.maxX - bbox.minX;
        const height = bbox.maxY - bbox.minY;
        const diag = Math.sqrt(width * width + height * height);
        if (diag < 30) return null;

        const start = points[0];
        const end = points[points.length - 1];
        const closeDist = Math.max(10, Math.min(width, height) * 0.2);
        const isClosed = this.distance(start, end) <= closeDist;

        if (this.isLine(points, bbox, diag)) return 'line';
        if (!isClosed) return null;

        if (this.isCircle(points, bbox)) return 'circle';

        const simplified = this.simplifyPath(points, Math.max(4, diag * 0.02));
        const closed = this.closePath(simplified, closeDist);
        if (closed.length === 4 && this.isRectangle(closed)) return 'rectangle';
        if (closed.length === 3 && this.isTriangle(closed, bbox)) return 'triangle';

        return null;
    }

    getBoundingBox(points) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        return { minX, minY, maxX, maxY };
    }

    distance(a, b) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    isLine(points, bbox, diag) {
        const width = bbox.maxX - bbox.minX;
        const height = bbox.maxY - bbox.minY;
        const longSide = Math.max(width, height);
        const shortSide = Math.min(width, height);
        if (longSide < 40 || shortSide / longSide > 0.25) return false;

        const start = points[0];
        const end = points[points.length - 1];
        const lineDist = this.maxDistanceToLine(points, start, end);
        return lineDist <= Math.max(6, diag * 0.02);
    }

    maxDistanceToLine(points, start, end) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const denom = Math.sqrt(dx * dx + dy * dy) || 1;
        let maxDist = 0;
        for (const p of points) {
            const dist = Math.abs(dy * p.x - dx * p.y + end.x * start.y - end.y * start.x) / denom;
            if (dist > maxDist) maxDist = dist;
        }
        return maxDist;
    }

    isCircle(points, bbox) {
        const width = bbox.maxX - bbox.minX;
        const height = bbox.maxY - bbox.minY;
        const ratio = width / (height || 1);
        if (ratio < 0.8 || ratio > 1.25) return false;
        if (points.length < 20) return false;

        const cx = (bbox.minX + bbox.maxX) / 2;
        const cy = (bbox.minY + bbox.maxY) / 2;
        let sum = 0;
        for (const p of points) {
            sum += this.distance(p, { x: cx, y: cy });
        }
        const mean = sum / points.length;
        let variance = 0;
        for (const p of points) {
            const d = this.distance(p, { x: cx, y: cy }) - mean;
            variance += d * d;
        }
        const stddev = Math.sqrt(variance / points.length);
        return stddev / mean < 0.2;
    }

    simplifyPath(points, epsilon) {
        if (points.length < 3) return points.slice();
        const first = points[0];
        const last = points[points.length - 1];

        let index = -1;
        let maxDist = 0;
        for (let i = 1; i < points.length - 1; i++) {
            const dist = this.perpendicularDistance(points[i], first, last);
            if (dist > maxDist) {
                maxDist = dist;
                index = i;
            }
        }

        if (maxDist > epsilon) {
            const left = this.simplifyPath(points.slice(0, index + 1), epsilon);
            const right = this.simplifyPath(points.slice(index), epsilon);
            return left.slice(0, -1).concat(right);
        }

        return [first, last];
    }

    perpendicularDistance(p, start, end) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        if (dx === 0 && dy === 0) return this.distance(p, start);
        const t = ((p.x - start.x) * dx + (p.y - start.y) * dy) / (dx * dx + dy * dy);
        const proj = { x: start.x + t * dx, y: start.y + t * dy };
        return this.distance(p, proj);
    }

    closePath(points, closeDist) {
        if (points.length < 2) return points.slice();
        const first = points[0];
        const last = points[points.length - 1];
        if (this.distance(first, last) <= closeDist) {
            return points.slice(0, -1);
        }
        return points.slice();
    }

    isRectangle(points) {
        if (points.length !== 4) return false;
        for (let i = 0; i < 4; i++) {
            const prev = points[(i + 3) % 4];
            const curr = points[i];
            const next = points[(i + 1) % 4];
            const v1 = { x: prev.x - curr.x, y: prev.y - curr.y };
            const v2 = { x: next.x - curr.x, y: next.y - curr.y };
            const dot = v1.x * v2.x + v1.y * v2.y;
            const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y) || 1;
            const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y) || 1;
            const cos = dot / (mag1 * mag2);
            if (Math.abs(cos) > 0.3) return false;
        }
        return true;
    }

    isTriangle(points, bbox) {
        if (points.length !== 3) return false;
        const area = Math.abs(
            (points[0].x * (points[1].y - points[2].y) +
            points[1].x * (points[2].y - points[0].y) +
            points[2].x * (points[0].y - points[1].y)) / 2
        );
        const width = bbox.maxX - bbox.minX;
        const height = bbox.maxY - bbox.minY;
        const boxArea = width * height || 1;
        return area / boxArea > 0.2;
    }

    async renderPDFPage(pdfPage) {
        if (!pdfPage) {
            console.warn("PDF page not provided");
            return;
        }

        // Use higher DPI for sharper PDF rendering
        const pdfDpr = 2; // Increase this for even sharper rendering (2x, 3x, etc.)
        this.pdfDpr = pdfDpr; // Store for later use
        
        const viewport = pdfPage.getViewport({ scale: 1.0 });
        const containerHeight = this.canvas.parentElement.offsetHeight;
        const scale = containerHeight / viewport.height;
        const scaledViewport = pdfPage.getViewport({ scale: scale * pdfDpr });

        // Canvas internal resolution is high (for sharp PDF)
        this.canvas.width = scaledViewport.width;
        this.canvas.height = scaledViewport.height;
        
        // CSS size stays normal (makes it look sharp)
        this.canvas.style.width = `${scaledViewport.width / pdfDpr}px`;
        this.canvas.style.height = `${scaledViewport.height / pdfDpr}px`;

        // Get fresh context
        this.ctx = this.canvas.getContext('2d');
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';

        await pdfPage.render({
            canvasContext: this.ctx,
            viewport: scaledViewport
        }).promise;
    }
    
    // Get display width (for positioning elements)
    getDisplayWidth() {
        return this.pdfDpr ? this.canvas.width / this.pdfDpr : this.canvas.width;
    }
    
    // Get display height (for positioning elements)
    getDisplayHeight() {
        return this.pdfDpr ? this.canvas.height / this.pdfDpr : this.canvas.height;
    }
    
    // Resize canvas to match container (for annotation canvas on window resize)
    resize() {
        const container = this.canvas.parentElement;
        if (!container) return;
        
        // Save current canvas content
        const imageData = this.canvas.toDataURL();
        
        // Get new dimensions
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        
        // Update canvas dimensions
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
        
        // Update context and scaling
        this.ctx = this.canvas.getContext('2d');
        this.ctx.scale(dpr, dpr);
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        this.dpr = dpr;
        
        // Restore content if there was any
        if (imageData && imageData !== 'data:,') {
            const img = new Image();
            img.onload = () => {
                const displayWidth = rect.width;
                const displayHeight = rect.height;
                this.ctx.drawImage(img, 0, 0, displayWidth, displayHeight);
            };
            img.src = imageData;
        }
    }
}
