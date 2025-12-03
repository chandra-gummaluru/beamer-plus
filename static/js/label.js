// label.js
export class Label {
    constructor(parent, { id = '', className = '', initial = '' } = {}) {
        this.el = document.createElement('label');
        if (id) this.el.id = id;
        if (className) this.el.className = className;
        this.el.textContent = initial;

        parent.appendChild(this.el);
    }

    // Update the text/content of the label
    set(value) {
        this.el.textContent = value;
    }

    // Get current value
    get() {
        return this.el.textContent;
    }
}
