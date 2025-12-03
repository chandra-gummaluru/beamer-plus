import { addHoldListener } from './events.js';

// timer.js
export class Timer {
    constructor(parent = document.body) {
        this.value     = 0;       // seconds
        this.running   = false;
        this.interval  = null;

        this.el = document.createElement("div");
        this.el.className = "timer_display";
        this.el.textContent = "00:00";

        parent.appendChild(this.el);

        this.render();
        this.setupEvents();
    }

    // functions
    tick() {
        this.value++;
        this.render();
    }

    start() {
        if (this.running) return;
        this.interval = setInterval(() => this.tick(), 1000);
        this.running = true;
        this.el.classList.add("timer_running");
    }

    stop() {
        clearInterval(this.interval);
        this.interval = null;
        this.running = false;
        this.el.classList.remove("timer_running");
    }

    reset() {
        this.stop();
        this.value = 0;
        this.render();
    }

    toggle() {
        this.running ? this.stop() : this.start();
    }

    // render
    render() {
        const min  = Math.floor(this.value / 60);
        const sec  = this.value % 60;
        this.el.textContent = `${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    }

    // events
    setupEvents() {
        // Click toggles start/stop
        this.el.addEventListener("click", () => this.toggle());

        // Hold resets
        addHoldListener(
            this.el,
            () => this.reset(),  // on hold
            800,                 // ms threshold
            () => this.toggle()  // on release (optional)
        );
    }
}
