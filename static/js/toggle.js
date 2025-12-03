export class Toggle {
    constructor(parent = document.body, { 
        id = '', 
        className = '', 
        iconClass = '', 
        initialState = false, 
        onToggle = null 
    } = {}) {
        this.state = initialState;  // true/false
        this.onToggle = onToggle;

        // Create the button element
        this.el = document.createElement('button');
        this.el.id = id;
        this.el.className = className;
        if (iconClass) {
            const icon = document.createElement('i');
            icon.className = iconClass;
            this.el.appendChild(icon);
        }

        // Initial style for state
        this.updateStyle();

        // Click toggles the state
        this.el.addEventListener('click', () => {
            this.toggle();
            if (typeof this.onToggle === 'function') {
                this.onToggle(this.state);
            }
        });

        parent.appendChild(this.el);
    }

    toggle() {
        this.state = !this.state;
        this.updateStyle();
    }

    setState(newState) {
        this.state = newState;
        this.updateStyle();
    }

    updateStyle() {
        if (this.state) {
            this.el.classList.add('toggle_on');
            this.el.classList.remove('toggle_off');
        } else {
            this.el.classList.add('toggle_off');
            this.el.classList.remove('toggle_on');
        }
    }
}
