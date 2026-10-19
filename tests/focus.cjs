// Run: node --test tests/focus.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function game() {
  const windowEvents = {}, documentEvents = {};
  const elements = new Map();
  const document = {
    hidden: false,
    createElement: () => ({ getContext: () => ({ fillRect() {} }) }),
    addEventListener(name, handler) { documentEvents[name] = handler; },
    getElementById(id) {
      if (!elements.has(id)) {
        const handlers = {}, captures = new Set(), attributes = {};
        elements.set(id, {
          width: 480, height: 300, getContext: () => ({}), handlers, attributes,
          setAttribute(name, value) { attributes[name] = value; }, focus() {},
          addEventListener(name, handler) { handlers[name] = handler; },
          setPointerCapture(id) { captures.add(id); },
          hasPointerCapture(id) { return captures.has(id); },
          releasePointerCapture(id) {
            if (captures.delete(id)) handlers.lostpointercapture?.({ pointerId: id });
          },
        });
      }
      return elements.get(id);
    },
  };
  const context = vm.createContext({
    document,
    window: { addEventListener(name, handler) { windowEvents[name] = handler; } },
    HTMLButtonElement: class {}, performance: { now: () => 0 },
    requestAnimationFrame() {},
  });
  const html = readFileSync(require.resolve('../index.html'), 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return {
    run: code => vm.runInContext(code, context),
    key: (code, target) => windowEvents.keydown({ code, target, preventDefault() {} }),
    blur: () => windowEvents.blur?.(),
    keyup: code => windowEvents.keyup({ code }),
    orientation: () => windowEvents.orientationchange?.(),
    touch(id, type, pointerId = 1, button = 0) {
      elements.get(`touch-${id}`).handlers[type]({ pointerId, button, preventDefault() {} });
    },
    button: id => elements.get(`touch-${id}`),
    action: (id, type, detail = 1) => elements.get(id).handlers[type]({ pointerType: 'touch', detail, preventDefault() {} }),
    visibility(hidden) { document.hidden = hidden; documentEvents.visibilitychange?.(); },
  };
}

for (const [name, loseFocus, returnFocus] of [
  ['window blur', g => g.blur(), () => {}],
  ['hidden document', g => g.visibility(true), g => g.visibility(false)],
]) {
  test(`${name} releases movement and fire without keyup; fresh input works`, () => {
    const g = game();
    g.run('startGame(); asteroids = [];');
    for (const code of ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyD', 'Space']) g.key(code);
    assert.equal(g.run('keys.size'), 7);
    loseFocus(g);
    assert.equal(g.run('keys.size'), 0);
    returnFocus(g);
    const angle = g.run('ship.angle');
    g.run('update(.05);');
    assert.equal(g.run('ship.angle'), angle);
    assert.equal(g.run('Math.hypot(ship.vx, ship.vy)'), 0);
    assert.equal(g.run('particles.length'), 0);
    assert.equal(g.run('bullets.length'), 0);
    if (g.run('state') === 'paused') g.run('togglePause();');
    g.key('ArrowUp'); g.key('ArrowLeft'); g.key('Space');
    g.run('update(.05);');
    assert.notEqual(g.run('ship.angle'), angle);
    assert.ok(g.run('Math.hypot(ship.vx, ship.vy)') > 0);
    assert.ok(g.run('particles.length') > 0);
    assert.equal(g.run('bullets.length'), 1);
  });
}

test('visible-document notification preserves active input', () => {
  const g = game();
  g.key('ArrowUp');
  g.visibility(false);
  assert.equal(g.run("keys.has('ArrowUp')"), true);
});

test('blur preserves normal ship inertia', () => {
  const g = game();
  g.run('startGame(); asteroids = []; ship.vx = 30;');
  g.key('ArrowUp'); g.blur();
  g.run('update(.05);');
  assert.ok(g.run('ship.vx') > 0);
  assert.equal(g.run('ship.vy'), 0);
});


test('restart and retry reset the score, sector, lives, and projectiles', () => {
  const g = game();
  g.run("score = 900; sector = 4; lives = 1; state = 'over'; startGame();");
  assert.equal(g.run('score'), 0);
  assert.equal(g.run('sector'), 1);
  assert.equal(g.run('lives'), 3);
  assert.equal(g.run('bullets.length'), 0);
});

test('paused projectiles preserve position and remaining life', () => {
  const g = game();
  g.run('startGame(); fire(); togglePause();');
  const before = g.run('JSON.stringify(bullets)');
  g.run('update(.05); update(.05);');
  assert.equal(g.run('JSON.stringify(bullets)'), before);
  g.run('togglePause(); update(.05);');
  assert.notEqual(g.run('JSON.stringify(bullets)'), before);
});

test('expired particles are removed during play', () => {
  const g = game();
  g.run('startGame(); asteroids = []; burst(20, 20, 10); update(1);');
  assert.equal(g.run('particles.length'), 0);
});

test('typing in account fields never triggers game shortcuts', () => {
  const g = game();
  for (const code of ['KeyR', 'KeyW', 'Enter', 'Space']) g.key(code, { closest: () => ({}) });
  assert.equal(g.run('state'), 'ready');
  assert.equal(g.run('keys.size'), 0);
});


test('three touch controls steer, thrust, and fire simultaneously; releasing one preserves the others', () => {
  const g = game();
  g.run('startGame(); asteroids = [];');
  g.touch('left', 'pointerdown', 1);
  g.touch('thrust', 'pointerdown', 2);
  g.touch('fire', 'pointerdown', 3);
  const heading = g.run('ship.angle');
  g.run('update(.05);');
  assert.ok(g.run('ship.angle') < heading);
  assert.ok(g.run('Math.hypot(ship.vx, ship.vy)') > 0);
  assert.equal(g.run('bullets.length'), 1);
  g.touch('left', 'pointerup', 1);
  assert.equal(g.run("pressed('ArrowLeft')"), false);
  assert.equal(g.run("pressed('ArrowUp') && pressed('Space')"), true);
});

test('multiple fingers on the same button release independently', () => {
  const g = game(); g.run('startGame();');
  g.touch('fire', 'pointerdown', 1); g.touch('fire', 'pointerdown', 2);
  g.touch('fire', 'pointerup', 1);
  assert.equal(g.run("pressed('Space')"), true);
  assert.equal(g.button('fire').attributes['aria-pressed'], 'true');
  g.touch('fire', 'pointerup', 2);
  assert.equal(g.run("pressed('Space')"), false);
  assert.equal(g.button('fire').attributes['aria-pressed'], 'false');
});

for (const type of ['pointercancel', 'lostpointercapture']) {
  test(`${type} releases touch input and its pressed appearance`, () => {
    const g = game(); g.run('startGame();');
    g.touch('fire', 'pointerdown'); g.touch('fire', type);
    assert.equal(g.run("pressed('Space')"), false);
    assert.equal(g.button('fire').attributes['aria-pressed'], 'false');
  });
}

test('keyboard and touch retain independent ownership of the same action', () => {
  const g = game(); g.run('startGame();');
  g.key('Space'); g.touch('fire', 'pointerdown'); g.touch('fire', 'pointerup');
  assert.equal(g.run("pressed('Space')"), true);
  g.touch('fire', 'pointerdown'); g.keyup('Space');
  assert.equal(g.run("pressed('Space')"), true);
  g.touch('fire', 'pointerup');
  assert.equal(g.run("pressed('Space')"), false);
});

for (const [name, interrupt, expectedState] of [
  ['blur', g => g.blur(), 'playing'],
  ['hidden page', g => g.visibility(true), 'paused'],
  ['orientation change', g => g.orientation(), 'paused'],
  ['pause', g => g.run('togglePause();'), 'paused'],
  ['restart', g => g.run('startGame();'), 'playing'],
]) {
  test(`${name} releases every held touch without stuck controls`, () => {
    const g = game(); g.run('startGame();');
    g.touch('thrust', 'pointerdown', 1); g.touch('fire', 'pointerdown', 2);
    interrupt(g);
    assert.equal(g.run('touchPointers.size'), 0);
    assert.equal(g.run('state'), expectedState);
    assert.equal(g.button('thrust').attributes['aria-pressed'], 'false');
    assert.equal(g.button('fire').attributes['aria-pressed'], 'false');
    if (expectedState === 'paused') assert.equal(g.button('fire').disabled, true);
  });
}

test('touch controls ignore ready, paused, game-over, and secondary-button input', () => {
  const g = game();
  for (const state of ['ready', 'paused', 'over']) {
    g.run(`state = '${state}';`); g.touch('fire', 'pointerdown');
    assert.equal(g.run('touchPointers.size'), 0);
  }
  g.run('startGame();'); g.touch('fire', 'pointerdown', 1, 2);
  assert.equal(g.run('touchPointers.size'), 0);
});

test('game over clears held touches and disables controls', () => {
  const g = game(); g.run('startGame();');
  g.touch('thrust', 'pointerdown', 1); g.touch('fire', 'pointerdown', 2);
  g.run('lives = 1; ship.invincible = 0; asteroids = [makeAsteroid(ship.x, ship.y, 3)]; update(.001);');
  assert.equal(g.run('state'), 'over');
  assert.equal(g.run('touchPointers.size'), 0);
  assert.equal(g.button('fire').disabled, true);
});


test('another finger pauses held controls once; compatibility click does not resume', () => {
  const g = game(); g.run('startGame();');
  g.touch('thrust', 'pointerdown', 1); g.touch('fire', 'pointerdown', 2);
  g.action('pause', 'pointerdown');
  assert.equal(g.run('state'), 'paused');
  assert.equal(g.run('touchPointers.size'), 0);
  g.action('pause', 'click');
  assert.equal(g.run('state'), 'paused');
  // Keyboard activation (detail 0) still resumes immediately.
  g.action('pause', 'click', 0);
  assert.equal(g.run('state'), 'playing');
});
