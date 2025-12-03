export class Canvas {
    constructor(container) {
        if (!container) throw new Error("Container element is required");

        // create the canvas element
        this.canvas = document.createElement('canvas');
        this.canvas.width = container.offsetWidth;
        this.canvas.height = container.offsetHeight;
        container.appendChild(this.canvas);

        // get 2D context
        this.ctx = this.canvas.getContext('2d');

        // optional state
        this.drawing = false;
        this.currentStroke = null;

        // bind events
        this.setupEvents();
    }

    setupEvents() {
        this.canvas.addEventListener('mousedown', e => this.startDraw(e));
        this.canvas.addEventListener('mousemove', e => this.draw(e));
        this.canvas.addEventListener('mouseup', e => this.stopDraw(e));
        this.canvas.addEventListener('mouseleave', e => this.stopDraw(e));

        this.canvas.addEventListener('touchstart', e => this.startDraw(e), { passive: false });
        this.canvas.addEventListener('touchmove', e => this.draw(e), { passive: false });
        this.canvas.addEventListener('touchend', e => this.stopDraw(e), { passive: false });
    }

    getPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        if (e.touches) {
            return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
        }
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    startDraw(e) {
        e.preventDefault();
        this.drawing = true;
        const p = this.getPos(e);
        this.currentStroke = { points: [p], color: 'black', width: 2 };
    }

    draw(e) {
        if (!this.drawing) return;
        e.preventDefault();
        const p = this.getPos(e);
        const pts = this.currentStroke.points;
        pts.push(p);

        const ctx = this.ctx;
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
}
