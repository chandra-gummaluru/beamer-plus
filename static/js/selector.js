// selector.js
export class Selector {
    constructor(buttons = [], activeClass = 'selected') {
        this.buttons = buttons;
        this.activeClass = activeClass;

        this.buttons.forEach(button => {
            button.el.addEventListener('click', () => this.select(button));
        });
    }

    select(buttonToSelect) {
        this.buttons.forEach(btn => btn.el.classList.remove(this.activeClass));
        buttonToSelect.el.classList.add(this.activeClass);
    }

    getSelected() {
        return this.buttons.find(btn => btn.el.classList.contains(this.activeClass));
    }
}
