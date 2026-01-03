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

        this.setupEvents(drawable);
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

    startDraw(e) {
        if (this.pointer_mode === "hand") {
            return;
        }

        e.preventDefault();
        this.drawing = true;

        const ctx = this.ctx;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        const p = this.getPos(e);

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

    // Load annotations from a data URL (image) and draw onto the canvas
    async loadAnnotations(dataURL) {
        if (!dataURL) return;
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                try {
                    // Clear existing
                    this.clear();
                    // Draw image scaled to canvas display size
                    const dw = this.canvas.width / this.dpr;
                    const dh = this.canvas.height / this.dpr;
                    this.ctx.drawImage(img, 0, 0, dw, dh);
                } catch (e) {
                    console.error('Error drawing annotations image:', e);
                }
                resolve();
            };
            img.onerror = () => resolve();
            img.src = dataURL;
        });
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