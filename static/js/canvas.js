export class Canvas {
    constructor(container, drawable=true) {
        if (!container) throw new Error("Container element is required");

        // create the canvas element
        this.canvas = document.createElement('canvas');
        this.canvas.width = container.offsetWidth;
        this.canvas.height = container.offsetHeight;
        this.pointer_mode = 'draw';
        container.appendChild(this.canvas);

        // get 2D context
        this.ctx = this.canvas.getContext('2d');

        // optional state
        this.drawing = false;
        this.currentStroke = null;
        this.strokeColor = 'black'
        this.strokeWidth = 2

        // bind events
        this.setupEvents(drawable);
    }

    setPointerMode(pointer_mode) {
        this.pointer_mode = pointer_mode
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
            return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
        }
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    setStrokeColor(strokeColor) {
        this.strokeColor = strokeColor
    }
    
    setStrokeWidth(strokeWidth) {
        this.strokeWidth = strokeWidth
    }

    startDraw(e) {
        e.preventDefault();
        this.drawing = true;

        const ctx = this.ctx;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        const p = this.getPos(e);

        let color = this.strokeColor;
        let width = this.strokeWidth;

        switch (this.pointer_mode) {
            case "draw":
                this.ctx.globalAlpha = 1
                this.ctx.globalCompositeOperation = "source-over";
                break;

            case "highlight":
                this.ctx.globalCompositeOperation = "multiply";
                this.ctx.globalAlpha = 0.1
                width = this.strokeWidth * 6;
                break;

            case "erase":
                this.ctx.globalCompositeOperation = "destination-out";
                this.ctx.globalAlpha = 1
                width = this.strokeWidth * 10;
                color = "white";
                break;
        }

        this.currentStroke = {
            points: [p],
            color,
            width
        };
    }

    add_annotations(annotations) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.putImageData(annotations, 0, 0);
    }

    get_annotations() {
        return this.ctx.getImageData(
            0, 0, this.ctx.canvas.width, this.ctx.canvas.height
        );
    }


    draw(e) {
        if (!this.drawing) return;
        e.preventDefault();
        const p = this.getPos(e);
        const pts = this.currentStroke.points;
        pts.push(p);

        const ctx = this.ctx;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = this.currentStroke.color;
        ctx.lineWidth = this.currentStroke.width;
        ctx.beginPath();
        ctx.moveTo(pts[pts.length - 2].x, pts[pts.length - 2].y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
    }

    stopDraw(e) {
        if (!this.drawing) return;
        e.preventDefault();
        this.drawing = false;
        this.currentStroke = null;
    }

    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    async renderPDFPage(pdfPage) {
        if (!pdfPage) {
            console.warn("PDF page not provided");
            return;
        }

        // Get viewport at scale 1
        const viewport = pdfPage.getViewport({ scale: 1.0 });

    // Calculate scale so that PDF fits the canvas container height
    const containerHeight = this.canvas.parentElement.offsetHeight; // or desired height
    const scale = containerHeight / viewport.height;

    const scaledViewport = pdfPage.getViewport({ scale });

    // Resize canvas to match scaled PDF page
    this.canvas.width = scaledViewport.width;
    this.canvas.height = scaledViewport.height;

        // Render page on canvas
        await pdfPage.render({
            canvasContext: this.ctx,
            viewport: scaledViewport
        }).promise;
    }
}