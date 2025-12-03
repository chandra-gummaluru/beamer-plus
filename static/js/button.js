// button.js
import { addHoldListener } from './events.js';

export class Button {
    constructor(parentOrSelector, options = {}) {
        const { label = '', className = '' } = options;

        this.el = document.createElement('button');
        this.el.innerHTML = label;
        this.el.className = className;

        // Append to parent
        let parent = typeof parentOrSelector === 'string' 
            ? document.querySelector(parentOrSelector) 
            : parentOrSelector || document.body;

        parent.appendChild(this.el);
    }
    
    onClick(fn) {
        this.el.addEventListener('click', fn);
    }

    setLabel(label) {
        this.el.innerHTML = label;
    }

    addClass(className) {
        this.el.classList.add(className);
    }

    removeClass(className) {
        this.el.classList.remove(className);
    }

    toggleClass(className) {
        this.el.classList.toggle(className);
    }
}
