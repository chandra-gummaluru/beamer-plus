// A short message at the bottom of the screen ("Saved …"), gone after 5 s.
// Shares the recorder's toast styling (#recorder-toast).

let timer = null;

export function toast(text) {
    let el = document.getElementById('recorder-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'recorder-toast';
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('is-visible');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('is-visible'), 5000);
}
