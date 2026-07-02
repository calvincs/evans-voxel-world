// On-screen touch controls for phones/tablets: a left thumb-stick to move, the
// right side of the screen to look around, and Jump / Break / Place buttons.
// Builds its own DOM so index.html stays clean. All input is gated on
// player.locked so it does nothing until the game is engaged.

export function setupTouchControls(player) {
  const make = (tag, id, cls, parent, text) => {
    const e = document.createElement(tag);
    if (id) e.id = id;
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    (parent || document.body).appendChild(e);
    return e;
  };

  const root = make('div', 'touch', 'hidden');
  const joy = make('div', 'joystick', null, root);
  const stick = make('div', 'stick', null, joy);
  const btnBreak = make('div', 'btn-break', 'touch-btn', root, '⛏');
  const btnPlace = make('div', 'btn-place', 'touch-btn', root, '🧱');  // reads "block", not "stop"
  const btnJump = make('div', 'btn-jump', 'touch-btn', root, '⭡');
  const btnView = make('div', 'btn-view', 'touch-btn', root, '👁');
  const btnMenu = make('div', 'btn-menu', 'touch-btn', root, '⏸');

  // Revealed by main.js when the player engages.
  player.onEngage = () => root.classList.remove('hidden');

  const JOY_R = 56;
  let joyId = null, joyCx = 0, joyCy = 0;
  let lookId = null, lookX = 0, lookY = 0;

  const startJoy = (t) => {
    const r = joy.getBoundingClientRect();
    joyCx = r.left + r.width / 2;
    joyCy = r.top + r.height / 2;
    joyId = t.identifier;
    moveJoy(t);
  };
  const moveJoy = (t) => {
    const dx = t.clientX - joyCx, dy = t.clientY - joyCy;
    const len = Math.hypot(dx, dy) || 1;
    const cl = Math.min(len, JOY_R);
    const nx = (dx / len) * cl, ny = (dy / len) * cl;
    stick.style.transform = `translate(${nx}px, ${ny}px)`;
    player.touchMove.x = nx / JOY_R;
    player.touchMove.y = -ny / JOY_R;        // push up = walk forward
  };
  const endJoy = () => {
    joyId = null;
    player.touchMove.x = player.touchMove.y = 0;
    stick.style.transform = 'translate(0,0)';
  };

  document.addEventListener('touchstart', (e) => {
    if (!player.locked) return;
    for (const t of e.changedTouches) {
      const el = document.elementFromPoint(t.clientX, t.clientY);
      if (el && el.closest('#joystick')) {
        if (joyId === null) startJoy(t);
      } else if (el && el.closest('.touch-btn, #hotbar')) {
        // buttons / hotbar handle their own taps
      } else if (lookId === null) {
        lookId = t.identifier; lookX = t.clientX; lookY = t.clientY;
      }
    }
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!player.locked) return;
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) { moveJoy(t); e.preventDefault(); }
      else if (t.identifier === lookId) {
        player.applyLook((t.clientX - lookX) * 1.4, (t.clientY - lookY) * 1.4);
        lookX = t.clientX; lookY = t.clientY;
        e.preventDefault();
      }
    }
  }, { passive: false });

  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) endJoy();
      else if (t.identifier === lookId) lookId = null;
    }
  };
  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', endTouch);

  const press = (el, on, off) => {
    el.addEventListener('touchstart', (e) => {
      if (!player.locked) return;
      e.preventDefault(); on();
    }, { passive: false });
    if (off) el.addEventListener('touchend', (e) => { e.preventDefault(); off(); },
      { passive: false });
  };
  press(btnJump, () => { player.wantJump = true; }, () => { player.wantJump = false; });
  // Hold to keep mining / placing (kids expect Minecraft's hold-to-dig).
  press(btnBreak, () => player.beginBreak(), () => player.endBreak());
  press(btnPlace, () => player.beginPlace(), () => player.endPlace());
  press(btnView, () => player.toggleView());

  // Pause: touch has no Esc, so without this an iPad player can never reach
  // the menu. Not routed through press() — it must work while locked.
  btnMenu.addEventListener('touchstart', (e) => {
    if (!player.locked) return;
    e.preventDefault();
    endJoy();
    player.wantJump = false;
    player.endBreak(); player.endPlace();
    player.locked = false;
    if (player.onPause) player.onPause();
  }, { passive: false });
}
