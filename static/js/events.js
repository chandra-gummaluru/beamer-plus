export function addHoldListener(el, onHold, holdTime = 500, onEnd) {
  let timerId = null;
  let held = false;

  const start = (e) => {
    if (e.type === 'touchstart') e.preventDefault();
    held = false;
    timerId = setTimeout(() => {
      held = true;
      onHold(e);
    }, holdTime);
  };

  const end = (e) => {
    clearTimeout(timerId);
    if (held && typeof onEnd === 'function') {
      onEnd(e);
    }
  };

  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', end);
  el.addEventListener('mouseleave', end);

  el.addEventListener('touchstart', start);
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
}
