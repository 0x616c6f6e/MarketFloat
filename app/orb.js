const button = document.querySelector('#orb');
const api = window.marketFloat;
let gesture;

button.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  gesture = { x: event.screenX, y: event.screenY, moved: false };
  button.setPointerCapture(event.pointerId);
  api.orbDown(event.screenX, event.screenY);
});

button.addEventListener('pointermove', event => {
  if (!gesture) return;
  if (Math.hypot(event.screenX - gesture.x, event.screenY - gesture.y) >= 5) gesture.moved = true;
  if (gesture.moved) api.orbMove();
});

button.addEventListener('pointerup', () => {
  if (!gesture) return;
  api.orbUp(gesture.moved);
  gesture = null;
});

button.addEventListener('pointercancel', () => {
  if (gesture) api.orbUp(true);
  gesture = null;
});

button.addEventListener('click', event => { if (event.detail === 0) api.orbOpen(); });
button.addEventListener('contextmenu', event => { event.preventDefault(); api.orbMenu(); });
