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
        // Prevent browser from hijacking touch/pen input for scrolling
        this.canvas.style.touchAction = 'none';
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

        // Inkwell-style drawing state
        this.pointQueue = [];     // raw input points queued for next rAF
        this.splinePts = [];      // rolling Catmull-Rom window (last 4+ drawn)
        this.rafId = null;
        this.cachedRect = null;   // cached per-stroke, not per-event
        this.TENSION = 0.5;
        this.useRawInput = false; // set true if pointerrawupdate available

        this.history = [];
        this.redoStack = [];
        this.maxHistory = 50;
        this.historyChangeHandler = null;
        this.shapeLock = null;
        this.shapeLockTimer = null;
        this.shapeLockDelay = 1000;
        this.lastMoveTime = 0;
        this.lastMovePoint = null;
        this.savedCanvasState = null;
        this.shapeTool = null;
        this.shapeMode = 'draw';

        this.setupEvents(drawable);
        this.commitHistory();
    }

    // ── Catmull-Rom spline segment ──────────────────────────────────────────
    catmullRomSegment(ctx, p0, p1, p2, p3) {
        const t = this.TENSION * 2;
        const cp1x = p1.x + (p2.x - p0.x) / 6 * t;
        const cp1y = p1.y + (p2.y - p0.y) / 6 * t;
        const cp2x = p2.x - (p3.x - p1.x) / 6 * t;
        const cp2y = p2.y - (p3.y - p1.y) / 6 * t;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }

    drawSplineSegment(ctx, p0, p1, p2, p3) {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        this.catmullRomSegment(ctx, p0, p1, p2, p3);
        ctx.stroke();
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

        // Browsers on e-ink panels report slow screen updates
        if (window.matchMedia?.('(update: slow)').matches) {
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

    setShapeTool(shapeTool) {
        this.shapeTool = shapeTool;
    }

    setShapeMode(shapeMode) {
        this.shapeMode = shapeMode;
    }

    setupEvents(drawable) {
        if (drawable) {
            // Bind handlers so we can add/remove them by reference
            this._onDown = e => this.startDraw(e);
            this._onMove = e => this.draw(e);
            this._onUp = e => this.stopDraw(e);

            // Use pointer events for unified mouse/touch/stylus handling
            this.canvas.addEventListener('pointerdown', this._onDown, { passive: false });
            this.canvas.addEventListener('pointermove', this._onMove, { passive: false });
            document.addEventListener('pointerup', this._onUp);
            document.addEventListener('pointercancel', this._onUp);
            this.canvas.addEventListener('contextmenu', e => e.preventDefault());
        }
    }

    getPos(e) {
        // Use cachedRect per-stroke for performance, fall back to fresh rect
        const rect = this.cachedRect || this.canvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }

    enqueuePoint(e) {
        const { x, y } = this.getPos(e);
        this.pointQueue.push({ x, y, pressure: e.pressure || 0.5 });
    }

    // ── rAF render loop: drains point queue each frame ────────────────────
    renderLoop() {
        if (!this.drawing && this.pointQueue.length === 0) { this.rafId = null; return; }
        this.rafId = requestAnimationFrame(() => this.renderLoop());

        if (this.pointQueue.length === 0) return;

        const batch = this.pointQueue;
        this.pointQueue = [];

        // Pick the right context (stroke buffer for highlighter)
        const ctx = (this.currentStroke && this.currentStroke.mode === 'highlight')
            ? this.strokeBufferCtx : this.ctx;

        for (const pt of batch) {
            // Shape-lock detection bookkeeping
            if (this.currentStroke) {
                this.currentStroke.points.push(pt);
                const now = Date.now();
                if (!this.shapeLock) {
                    this.lastMoveTime = now;
                    this.lastMovePoint = pt;
                    if (this.shapeLockTimer) clearTimeout(this.shapeLockTimer);
                    this.shapeLockTimer = setTimeout(() => this.tryLockShape(), this.shapeLockDelay);
                }
                if (this.shapeLock) continue;   // already snapped — ignore the wobble
            }

            this.splinePts.push(pt);
            const n = this.splinePts.length;

            if (n === 2) {
                // First segment: just a line
                ctx.beginPath();
                ctx.moveTo(this.splinePts[0].x, this.splinePts[0].y);
                ctx.lineTo(this.splinePts[1].x, this.splinePts[1].y);
                ctx.stroke();
            } else if (n >= 4) {
                // Full Catmull-Rom with look-ahead
                this.drawSplineSegment(
                    ctx,
                    this.splinePts[n - 4],
                    this.splinePts[n - 3],
                    this.splinePts[n - 2],
                    this.splinePts[n - 1]
                );
            }

            // Keep buffer trimmed — only last 4 needed for next segment
            if (this.splinePts.length > 8) this.splinePts = this.splinePts.slice(-4);
        }

        // For highlighter, composite the buffer to main canvas in real-time
        if (this.currentStroke && this.currentStroke.mode === 'highlight') {
            this.ctx.putImageData(this.savedCanvasState, 0, 0);
            this.ctx.save();
            this.ctx.globalAlpha = 0.4;
            this.ctx.globalCompositeOperation = 'multiply';
            const rect = this.canvas.getBoundingClientRect();
            this.ctx.drawImage(this.strokeBuffer, 0, 0, rect.width, rect.height);
            this.ctx.restore();
        }
    }

    drawSegmentToContext(start, end, ctx, stroke) {
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = stroke.mode === 'erase' ? 'rgba(0,0,0,1)' : stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over';
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
    }

    restoreStrokeBaseline(stroke) {
        if (!this.savedCanvasState || !stroke) return;
        this.ctx.putImageData(this.savedCanvasState, 0, 0);
        if (stroke.mode === 'highlight') {
            this.strokeBufferCtx.clearRect(0, 0, this.strokeBuffer.width, this.strokeBuffer.height);
        }
    }

    drawSegmentPreview(start, end) {
        if (!this.currentStroke || !this.savedCanvasState) return;

        this.restoreStrokeBaseline(this.currentStroke);

        if (this.currentStroke.mode === 'highlight') {
            this.drawSegmentToContext(start, end, this.strokeBufferCtx, this.currentStroke);
            const rect = this.canvas.getBoundingClientRect();
            this.ctx.save();
            this.ctx.globalAlpha = 0.4;
            this.ctx.globalCompositeOperation = 'multiply';
            this.ctx.drawImage(this.strokeBuffer, 0, 0, rect.width, rect.height);
            this.ctx.restore();
            return;
        }

        this.drawSegmentToContext(start, end, this.ctx, this.currentStroke);
    }

    commitSegment(start, end) {
        if (!this.currentStroke || !this.savedCanvasState) return;

        this.drawSegmentPreview(start, end);
        this.savedCanvasState = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
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

    // The last committed annotation state. Prefer this over getSnapshot() when
    // persisting: resizeOnly() (fired on split/layout changes) clears the live
    // bitmap but leaves history intact, so the live canvas can be transiently
    // blank while the real annotation still lives in the last history entry.
    // Falls back to the live snapshot before any history exists.
    getCommittedSnapshot() {
        return this.history[this.history.length - 1] ?? this.getSnapshot();
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
        if (this.pointer_mode === "hand") return;
        if (!e.isPrimary) return;

        // Text tool: track the down point/time ourselves rather than relying on
        // the browser's synthetic 'click' event (which pointer-capture / touch-
        // action interactions can suppress). stopDraw() below turns this into a
        // textbox placement if the pointer didn't move much before releasing.
        if (this.pointer_mode === "text") {
            this._textDownPos = this.getPos(e);
            this._textDownTime = Date.now();
            return;
        }

        e.preventDefault();

        // Capture pointer so events keep flowing even if pointer leaves canvas
        this.canvas.setPointerCapture(e.pointerId);

        this.drawing = true;
        this.shapeLock = null;
        this.splinePts = [];
        this.pointQueue = [];
        this.cachedRect = this.canvas.getBoundingClientRect(); // cache once per stroke

        if (this.shapeLockTimer) {
            clearTimeout(this.shapeLockTimer);
            this.shapeLockTimer = null;
        }
        this.savedCanvasState = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

        const p = this.getPos(e);
        this.lastMoveTime = Date.now();
        this.lastMovePoint = p;

        let color = this.strokeColor;
        let width = this.strokeWidth;
        let mode = this.pointer_mode;

        if (this.pointer_mode === "shape") {
            const shapeMode = this.shapeMode || 'draw';
            if (shapeMode === 'highlight') {
                const rect = this.canvas.getBoundingClientRect();
                this.strokeBuffer.width = rect.width * this.dpr;
                this.strokeBuffer.height = rect.height * this.dpr;
                this.strokeBufferCtx = this.strokeBuffer.getContext("2d");
                this.strokeBufferCtx.scale(this.dpr, this.dpr);
                this.strokeBufferCtx.lineCap = 'round';
                this.strokeBufferCtx.lineJoin = 'round';
                this.strokeBufferCtx.imageSmoothingEnabled = true;
                this.strokeBufferCtx.imageSmoothingQuality = 'high';
                this.strokeBufferCtx.globalAlpha = 1;
                this.strokeBufferCtx.globalCompositeOperation = "source-over";
                this.savedCanvasState = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
                width = this.strokeWidth * 8;
            } else if (shapeMode === 'erase') {
                this.ctx.globalCompositeOperation = "destination-out";
                this.ctx.globalAlpha = 1;
                width = this.strokeWidth * 12;
                color = "white";
            } else {
                this.ctx.globalAlpha = 1;
                this.ctx.globalCompositeOperation = "source-over";
            }

            this.currentStroke = {
                start: p,
                end: p,
                color,
                width,
                mode: shapeMode,
                shape: this.shapeTool
            };
            return;
        }

        switch (this.pointer_mode) {
            case "draw":
                this.ctx.globalAlpha = 1;
                this.ctx.globalCompositeOperation = "source-over";
                break;

            case "highlight": {
                // For highlighter, setup a stroke buffer
                const rect = this.cachedRect;
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
            }

            case "erase":
                this.ctx.globalCompositeOperation = "destination-out";
                this.ctx.globalAlpha = 1;
                width = this.strokeWidth * 12;
                color = "white";
                break;
        }

        // Configure drawing context
        const drawCtx = (mode === 'highlight') ? this.strokeBufferCtx : this.ctx;
        drawCtx.lineJoin = 'round';
        drawCtx.lineCap = 'round';
        drawCtx.strokeStyle = (mode === 'erase') ? 'rgba(0,0,0,1)' : color;
        drawCtx.lineWidth = width;

        this.currentStroke = {
            points: [{ ...p, pressure: e.pressure || 0.5 }],
            color,
            width,
            mode,
            segmentStart: p,
            currentPoint: p,
            polylineActive: false
        };

        this.enqueuePoint(e);

        // Start the rAF render loop
        if (!this.rafId) this.rafId = requestAnimationFrame(() => this.renderLoop());
    }

    draw(e) {
        if (this.pointer_mode === "hand" || this.pointer_mode === "text") return;
        if (!e.isPrimary || !this.drawing) return;
        e.preventDefault();

        if (this.currentStroke?.polylineActive) {
            const coalescedPoints = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
            const latestEvent = coalescedPoints[coalescedPoints.length - 1];
            const point = this.getPos(latestEvent);

            this.currentStroke.currentPoint = point;
            this.lastMoveTime = Date.now();
            this.lastMovePoint = point;

            if (this.shapeLockTimer) clearTimeout(this.shapeLockTimer);
            this.shapeLockTimer = setTimeout(() => this.tryLockShape(), this.shapeLockDelay);

            this.drawSegmentPreview(this.currentStroke.segmentStart, point);
            return;
        }

        // Throttle drawing updates for e-ink
        const now = Date.now();
        if (this.isEink && now - this.lastDrawTime < this.drawThrottle) {
            return;
        }
        this.lastDrawTime = now;

        const p = this.getPos(e);

        // Explicit shape-tool preview
        if (this.currentStroke && this.currentStroke.shape) {
            this.currentStroke.end = p;
            this.drawShapePreview(this.currentStroke);
            return;
        }

        // Drain all coalesced points — browser batches these between frames
        const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];

        for (const ptEvent of coalesced) {
            const pt = this.getPos(ptEvent);

            // Skip if point is too close to last point on e-ink
            if (this.isEink && this.currentStroke?.points?.length > 0) {
                const lastPt = this.currentStroke.points[this.currentStroke.points.length - 1];
                const dist = Math.sqrt((pt.x - lastPt.x) ** 2 + (pt.y - lastPt.y) ** 2);
                if (dist < this.minPointDistance) continue;
            }

            this.enqueuePoint(ptEvent);
        }
    }

    stopDraw(e) {
        if (this.pointer_mode === "hand") return;

        if (this.pointer_mode === "text") {
            const down = this._textDownPos;
            this._textDownPos = null;
            this._textDownTime = null;
            if (!down || !this.onTextPlace) return;
            // Only a small pointer movement between down and up counts as a tap —
            // a longer drag (e.g. panning) shouldn't drop a textbox.
            const up = (e.clientX !== 0 || e.clientY !== 0) ? this.getPos(e) : down;
            const moved = this.distance(down, up);
            if (moved < 8) this.onTextPlace(down);
            return;
        }

        if (!this.drawing) return;

        this.drawing = false;
        e.preventDefault();

        // Finalize explicit shape-tool drawing
        if (this.currentStroke && this.currentStroke.shape) {
            this.drawShapePreview(this.currentStroke);

            if (this.currentStroke.mode === 'highlight') {
                this.strokeBufferCtx.clearRect(0, 0, this.strokeBuffer.width, this.strokeBuffer.height);
            }

            this.currentStroke = null;
            this.ctx.globalCompositeOperation = "source-over";
            this.ctx.globalAlpha = 1;
            this.savedCanvasState = null;
            this.cachedRect = null;
            this.commitHistory();
            return;
        }

        // Snapped to a shape (draw and hold): it is already drawn — drop the
        // leftover freehand points and finish.
        if (this.shapeLock && this.currentStroke) {
            if (this.shapeLockTimer) { clearTimeout(this.shapeLockTimer); this.shapeLockTimer = null; }
            this.pointQueue = [];
            this.splinePts = [];
            this.drawLockedShape();
            if (this.currentStroke.mode === 'highlight') {
                this.strokeBufferCtx.clearRect(0, 0, this.strokeBuffer.width, this.strokeBuffer.height);
            }
            this.shapeLock = null;
            this.currentStroke = null;
            this.ctx.globalCompositeOperation = "source-over";
            this.ctx.globalAlpha = 1;
            this.savedCanvasState = null;
            this.cachedRect = null;
            this.commitHistory();
            return;
        }

        // Only enqueue the final point if the event has valid coordinates
        // (pointercancel can have clientX/clientY of 0 on some devices)
        if (e.clientX !== 0 || e.clientY !== 0) {
            this.enqueuePoint(e);
        }

        if (this.shapeLockTimer) {
            clearTimeout(this.shapeLockTimer);
            this.shapeLockTimer = null;
        }

        if (this.currentStroke?.polylineActive) {
            const endPoint = (e.clientX !== 0 || e.clientY !== 0)
                ? this.getPos(e)
                : this.currentStroke.currentPoint;

            if (endPoint && this.distance(this.currentStroke.segmentStart, endPoint) > 0.5) {
                this.commitSegment(this.currentStroke.segmentStart, endPoint);
            } else {
                this.restoreStrokeBaseline(this.currentStroke);
            }

            this.currentStroke = null;
            this.ctx.globalCompositeOperation = "source-over";
            this.ctx.globalAlpha = 1;
            this.savedCanvasState = null;
            this.cachedRect = null;
            this.commitHistory();
            return;
        }

        // Pick draw context
        const ctx = (this.currentStroke && this.currentStroke.mode === 'highlight')
            ? this.strokeBufferCtx : this.ctx;

        // Flush remaining queued points synchronously so stroke ends precisely
        for (const pt of this.pointQueue) {
            this.splinePts.push(pt);
            const m = this.splinePts.length;
            if (m === 2) {
                ctx.beginPath();
                ctx.moveTo(this.splinePts[0].x, this.splinePts[0].y);
                ctx.lineTo(this.splinePts[1].x, this.splinePts[1].y);
                ctx.stroke();
            } else if (m >= 4) {
                this.drawSplineSegment(
                    ctx,
                    this.splinePts[m - 4],
                    this.splinePts[m - 3],
                    this.splinePts[m - 2],
                    this.splinePts[m - 1]
                );
            }
            if (this.splinePts.length > 8) this.splinePts = this.splinePts.slice(-4);
        }
        this.pointQueue = [];

        // Draw final tail segment with phantom look-ahead
        const m = this.splinePts.length;
        if (m >= 2) {
            const p1 = this.splinePts[m - 2];
            const p2 = this.splinePts[m - 1];
            const p0 = m >= 3 ? this.splinePts[m - 3] : p1;
            const p3 = { x: p2.x + (p2.x - p1.x), y: p2.y + (p2.y - p1.y), pressure: p2.pressure };
            this.drawSplineSegment(ctx, p0, p1, p2, p3);
        }

        this.splinePts = [];

        // For highlighter, finalize the composite
        if (this.currentStroke && this.currentStroke.mode === 'highlight') {
            this.ctx.putImageData(this.savedCanvasState, 0, 0);
            this.ctx.save();
            this.ctx.globalAlpha = 0.4;
            this.ctx.globalCompositeOperation = "multiply";
            const rect = this.canvas.getBoundingClientRect();
            this.ctx.drawImage(this.strokeBuffer, 0, 0, rect.width, rect.height);
            this.ctx.restore();
            this.strokeBufferCtx.clearRect(0, 0, this.strokeBuffer.width, this.strokeBuffer.height);
        }

        this.currentStroke = null;
        this.ctx.globalCompositeOperation = "source-over";
        this.ctx.globalAlpha = 1;
        this.savedCanvasState = null;
        this.cachedRect = null;
        this.commitHistory();
    }

    tryLockShape() {
        this.shapeLockTimer = null;
        if (this.shapeLock || !this.drawing || !this.currentStroke) return;
        if (Date.now() - this.lastMoveTime < this.shapeLockDelay) return;

        // Draw-and-hold on a closed stroke (end near the start) snaps it to the
        // shape it looks like: circle/ellipse, triangle or rectangle. Anything
        // else falls through to the straight-line behaviour below.
        if (!this.currentStroke.shape && !this.currentStroke.polylineActive
            && ['draw', 'highlight'].includes(this.currentStroke.mode)) {
            const fitted = this.fitClosedShape(this.currentStroke.points || []);
            if (fitted) {
                this.shapeLock = fitted;
                this.pointQueue = [];
                this.splinePts = [];
                this.drawLockedShape();
                return;
            }
        }

        if (!this.currentStroke.shape && ['draw', 'highlight'].includes(this.currentStroke.mode)) {
            const points = this.currentStroke.points || [];
            const endPoint = this.lastMovePoint || this.currentStroke.currentPoint || points[points.length - 1];
            const segmentStart = this.currentStroke.segmentStart || points[0];

            if (!segmentStart || !endPoint || this.distance(segmentStart, endPoint) < 1) return;

            this.commitSegment(segmentStart, endPoint);
            this.currentStroke.polylineActive = true;
            this.currentStroke.segmentStart = endPoint;
            this.currentStroke.currentPoint = endPoint;
            this.currentStroke.points = [{ ...endPoint, pressure: 0.5 }];
            this.pointQueue = [];
            this.splinePts = [];
            return;
        }

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

    /* ── closed-shape recognition (draw and hold) ─────────────────────
       Returns a shape to draw in place of the stroke, or null. Fitted to
       where the stroke actually went: an ellipse to its bounds (a true
       circle when nearly round), a triangle through its three corners, a
       rectangle to its bounds when square to the page, else through its
       four corners. */
    fitClosedShape(points) {
        if (points.length < 12) return null;
        const bbox = this.getBoundingBox(points);
        const w = bbox.maxX - bbox.minX, h = bbox.maxY - bbox.minY;
        const diag = Math.hypot(w, h);
        if (diag < 30 || Math.min(w, h) < 12) return null;

        // Closed: the stroke ends near where it began.
        const closeDist = Math.max(14, diag * 0.18);
        if (this.distance(points[0], points[points.length - 1]) > closeDist) return null;

        const cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2;

        // Corners: simplify, drop the duplicated closing point and any
        // near-straight vertices (e.g. where the stroke started mid-edge).
        const simplified = this.simplifyPath(points, Math.max(5, diag * 0.06));
        const corners = this.dropFlatVertices(this.closePath(simplified, closeDist));

        if (corners.length === 3 && this.isTriangle(corners, bbox)) {
            return { type: 'polygon', points: corners };
        }
        if (corners.length === 4 && this.isRectangle(corners)) {
            const square = corners.every((p, i) => {
                const q = corners[(i + 1) % 4];
                const a = Math.abs(Math.atan2(q.y - p.y, q.x - p.x)) % (Math.PI / 2);
                return Math.min(a, Math.PI / 2 - a) < 0.26;   // within ~15° of the axes
            });
            return square
                ? { type: 'rectangle', center: { x: cx, y: cy }, width: w, height: h }
                : { type: 'polygon', points: corners };
        }

        // Round: every point about the same normalised distance from the centre.
        if (this.isEllipse(points, bbox)) {
            const ratio = w / h;
            if (ratio > 0.85 && ratio < 1.18) {
                return { type: 'circle', center: { x: cx, y: cy }, width: (w + h) / 2, height: (w + h) / 2 };
            }
            return { type: 'ellipse', center: { x: cx, y: cy }, width: w, height: h };
        }
        return null;
    }

    isEllipse(points, bbox) {
        const rx = (bbox.maxX - bbox.minX) / 2 || 1, ry = (bbox.maxY - bbox.minY) / 2 || 1;
        const cx = bbox.minX + rx, cy = bbox.minY + ry;
        let sum = 0, sq = 0;
        for (const p of points) {
            const d = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
            sum += d; sq += d * d;
        }
        const mean = sum / points.length;
        const sd = Math.sqrt(Math.max(0, sq / points.length - mean * mean));
        return mean > 0.7 && sd / mean < 0.12;
    }

    // Remove vertices whose two edges are nearly in line (angle > ~155°).
    dropFlatVertices(pts) {
        let out = pts.slice();
        let changed = true;
        while (changed && out.length > 3) {
            changed = false;
            for (let i = 0; i < out.length; i++) {
                const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
                const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
                const cos = (v1.x * v2.x + v1.y * v2.y) / ((Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)) || 1);
                if (cos < -0.9) { out.splice(i, 1); changed = true; break; }
            }
        }
        return out;
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
        } else if (type === 'ellipse') {
            ctx.ellipse(center.x, center.y, width / 2, height / 2, 0, 0, Math.PI * 2);
        } else if (type === 'polygon') {
            shape.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.closePath();
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

    drawShapePreview(stroke) {
        if (!stroke || !this.savedCanvasState) return;
        if (stroke.mode === 'highlight') {
            this.ctx.putImageData(this.savedCanvasState, 0, 0);
            this.strokeBufferCtx.clearRect(0, 0, this.strokeBuffer.width, this.strokeBuffer.height);
            this.strokeBufferCtx.lineJoin = 'round';
            this.strokeBufferCtx.lineCap = 'round';
            this.strokeBufferCtx.strokeStyle = stroke.color;
            this.strokeBufferCtx.lineWidth = stroke.width;
            this.strokeBufferCtx.globalAlpha = 1;
            this.strokeBufferCtx.globalCompositeOperation = "source-over";
            this.drawShapeFromPoints(stroke.shape, stroke.start, stroke.end, this.strokeBufferCtx);

            const rect = this.canvas.getBoundingClientRect();
            this.ctx.save();
            this.ctx.globalAlpha = 0.4;
            this.ctx.globalCompositeOperation = "multiply";
            this.ctx.drawImage(this.strokeBuffer, 0, 0, rect.width, rect.height);
            this.ctx.restore();
            return;
        }

        this.ctx.putImageData(this.savedCanvasState, 0, 0);
        this.ctx.lineJoin = 'round';
        this.ctx.lineCap = 'round';
        this.ctx.strokeStyle = stroke.color;
        this.ctx.lineWidth = stroke.width;
        this.ctx.globalAlpha = 1;
        if (stroke.mode === 'erase') {
            this.ctx.globalCompositeOperation = "destination-out";
        } else {
            this.ctx.globalCompositeOperation = "source-over";
        }
        this.drawShapeFromPoints(stroke.shape, stroke.start, stroke.end, this.ctx);
    }

    drawShapeFromPoints(type, start, end, ctx) {
        if (!type || !start || !end) return;
        const left = Math.min(start.x, end.x);
        const right = Math.max(start.x, end.x);
        const top = Math.min(start.y, end.y);
        const bottom = Math.max(start.y, end.y);
        const width = right - left;
        const height = bottom - top;
        const centerX = left + width / 2;
        const centerY = top + height / 2;

        ctx.beginPath();
        if (type === 'line') {
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
        } else if (type === 'rectangle') {
            ctx.strokeRect(left, top, width, height);
            return;
        } else if (type === 'circle') {
            const radius = Math.max(width, height) / 2;
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        } else if (type === 'triangle') {
            ctx.moveTo(centerX, top);
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

    // Resize canvas dimensions only — no content restore.
    // Use this when a renderSlide/renderSlideRight call is coming immediately after,
    // to avoid an img.onload race overwriting the annotation repaint.
    resizeOnly() {
        const container = this.canvas.parentElement;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
        this.ctx = this.canvas.getContext('2d');
        this.ctx.scale(dpr, dpr);
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        this.dpr = dpr;
    }
}
