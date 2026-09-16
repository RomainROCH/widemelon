// Browser event/state regressions against the actual bundled controller script.
// Copyright (C) 2026 WideMelon contributors
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function page(storageBlocked = false, savedMapping = null) {
  const elements = new Map();
  const customElements = new Set();
  function element() {
    const handlers = new Map();
    const classes = new Set();
    return {
      handlers, dataset: {}, style: {setProperty() {}},
      classList: {add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
        toggle(c, active) { if (active) classes.add(c); else classes.delete(c); },
        contains(c) { return classes.has(c); }},
      addEventListener(name, fn) { handlers.set(name, fn); },
      fire(name, extra = {}) { handlers.get(name)?.({preventDefault() {}, ...extra}); },
      setPointerCapture() {}, setAttribute() {}, focus() {},
      appendChild(child) { customElements.add(child); },
      remove() { customElements.delete(this); },
      getBoundingClientRect() { return {left: 0, top: 0, width: 256, height: 192}; }
    };
  }
  const document = element();
  document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const buttons = [['x', 10], ['y', 11], ['a', 0], ['b', 1], ['l', 9], ['r', 8],
    ['select', 2], ['start', 3]].map(([id, bit]) => {
    const button = document.getElementById(id);
    button.dataset.button = String(bit);
    return button;
  });
  for (const id of ['screen', 'dpad', 'face', 'l', 'r', 'start', 'select'])
    document.getElementById(id).dataset.layoutId = id;
  const mapTargets = Array.from({length: 12}, (_, bit) => {
    const target = document.getElementById(`map-${bit}`);
    target.dataset.dsBit = String(bit);
    return target;
  });
  document.createElement = element;
  document.querySelectorAll = selector => {
    const all = [...elements.values(), ...customElements];
    if (selector.includes('[data-button]')) return all.filter(el => el.dataset.button !== undefined
      || (selector.includes('[data-hotkey]') && el.dataset.hotkey !== undefined));
    if (selector === '[data-layout-id]') return all.filter(el => el.dataset.layoutId);
    if (selector === '[data-layout-custom]') return [...customElements];
    return selector === '#controller-diagram .map-target' ? mapTargets : [];
  };
  document.querySelector = selector => document.querySelectorAll('[data-layout-id]')
    .find(el => selector === `[data-layout-id="${el.dataset.layoutId}"]`) || null;
  const draws = [];
  document.getElementById('screen').getContext = () => ({drawImage(bitmap) { draws.push(bitmap.id); }});
  const window = element();
  const sockets = [];
  class WebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor() { this.readyState = 0; this.sent = []; this.sentAt = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); this.sentAt.push(clock); }
    open() { this.readyState = 1; this.onopen(); }
    message(data) { this.onmessage({data: typeof data === 'object' && !(data instanceof ArrayBuffer)
      ? JSON.stringify(data) : data}); }
    close(reason = '') { this.readyState = 3; this.onclose({reason}); }
  }
  let clock = 0, timerId = 0;
  const timers = new Map();
  const timer = (fn, delay, repeat = false) => {
    const id = ++timerId;
    timers.set(id, {fn, delay, repeat, at: clock + delay});
    return id;
  };
  function tick(ms) {
    const end = clock + ms;
    for (;;) {
      const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, t] = entry;
      clock = t.at;
      timers.delete(id);
      if (t.repeat) timers.set(id, {...t, at: clock + t.delay});
      t.fn();
    }
    clock = end;
  }
  const decodes = [];
  const replacedUrls = [];
  const storage = new Map();
  if (savedMapping) storage.set('widemelonGamepadMapping', JSON.stringify(savedMapping));
  const gamepads = [];
  const sandbox = {document, window, WebSocket, ArrayBuffer, DataView, Uint8Array, Blob,
    URLSearchParams, CSS: {escape: value => value}, performance: {now: () => clock},
    navigator: {getGamepads: () => gamepads},
    location: {host: '127.0.0.1:24800', hash: '#pair=' + 'A'.repeat(43), pathname: '/', search: ''},
    history: {replaceState(a, b, url) { replacedUrls.push(url); }},
    sessionStorage: {
      getItem(key) { if (storageBlocked) throw Error('storage disabled'); return storage.get(key); },
      setItem(key, value) { if (storageBlocked) throw Error('storage disabled'); storage.set(key, value); },
      removeItem(key) { if (storageBlocked) throw Error('storage disabled'); storage.delete(key); }
    },
    localStorage: {
      getItem(key) { if (storageBlocked) throw Error('storage disabled'); return storage.get(key); },
      setItem(key, value) { if (storageBlocked) throw Error('storage disabled'); storage.set(key, value); },
      removeItem(key) { if (storageBlocked) throw Error('storage disabled'); storage.delete(key); }
    },
    setTimeout: (fn, delay) => timer(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => timer(fn, delay, true),
    requestAnimationFrame: fn => timer(fn, 16),
    createImageBitmap: () => new Promise(resolve => decodes.push(resolve))};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/frontend/qt_sdl/phone/app.js'), 'utf8'), sandbox);
  return {document, window, sockets, tick, decodes, draws, storage, gamepads, replacedUrls, now: () => clock};
}

function frame(sequence) {
  const buffer = new ArrayBuffer(28);
  const view = new DataView(buffer);
  view.setUint32(0, 0x574d4632);
  view.setUint32(4, sequence, true);
  view.setUint8(20, 1);
  return buffer;
}
async function decode(p, id) {
  let closed = false;
  p.decodes.shift()({id, close() { closed = true; }});
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert(closed, 'decoded bitmap must be released');
}

(async () => {
  const layoutPage = page();
  const layoutSocket = layoutPage.sockets[0];
  const builtInIds = ['dpad', 'face', 'l', 'r', 'start', 'select'];
  const layout = {version: 2, items: ['screen', ...builtInIds].map(id => ({
    id, kind: id === 'screen' ? 'screen' : id === 'dpad' ? 'directional' : id === 'face' ? 'face' : 'button',
    x: .1, y: .2, w: .3, h: .4, appearance: 'analog'
  }))};
  layout.items.push({id: 'custom-pause', kind: 'button', label: 'Pause', hotkey: 2,
    x: .8, y: .7, w: .1, h: .1});
  const control = id => layoutPage.document.querySelector(`[data-layout-id="${id}"]`);
  const apply = () => layoutSocket.message({v: 2, type: 'layout', layout});
  layoutSocket.open();
  layoutSocket.message({v: 2, type: 'hello', layout});
  for (const id of builtInIds) assert.equal(control(id).hidden, false, 'legacy layouts show DS controls');
  layoutPage.document.getElementById('a').fire('pointerdown', {pointerId: 1});
  assert.equal(layoutSocket.sent.at(-1).buttons, 1);
  layout.showDsControls = false;
  apply();
  assert.equal(layoutSocket.sent.findLast(m => m.type === 'input').buttons, 0, 'layout change releases held input');
  for (const id of builtInIds) assert.equal(control(id).hidden, true, `${id} must be hidden`);
  assert.equal(control('screen').hidden, false);
  assert.equal(control('custom-pause').hidden, false);
  control('screen').fire('pointerdown', {pointerId: 2, clientX: 123, clientY: 45});
  control('custom-pause').fire('pointerdown', {pointerId: 3});
  assert.deepEqual(layoutSocket.sent.at(-1).touch, {active: true, x: 123, y: 45});
  assert.equal(layoutSocket.sent.at(-1).hotkeys, 1 << 2);
  layoutSocket.message(frame(77));
  await decode(layoutPage, 77);
  assert.deepEqual(layoutPage.draws, [77], 'touchscreen-only still draws frames');
  assert.equal(layoutSocket.sent.at(-1).type, 'frameAck');
  const layoutPad = {index: 0, connected: true, mapping: 'standard',
    buttons: Array.from({length: 16}, () => ({pressed: false})), axes: [0, 0]};
  layoutPage.gamepads[0] = layoutPad;
  layoutPage.tick(16);
  assert.equal(layoutSocket.sent.findLast(m => m.type === 'input').hotkeys, 1 << 2,
    'gamepad mode preserves custom action holds in touchscreen-only layouts');
  layoutPage.document.getElementById('virtual-controls').fire('click');
  for (const id of builtInIds) assert.equal(control(id).hidden, true, 'phone toggle respects the saved layout');
  layoutPad.connected = false;
  layoutPage.tick(16);
  for (const id of builtInIds) assert.equal(control(id).hidden, true, 'gamepad disconnect respects the saved layout');
  layoutSocket.close();
  layoutPage.tick(250);
  const reconnectedLayoutSocket = layoutPage.sockets.at(-1);
  reconnectedLayoutSocket.open();
  reconnectedLayoutSocket.message({v: 2, type: 'hello', layout});
  for (const id of builtInIds) assert.equal(control(id).hidden, true, 'reconnect restores touchscreen-only layout');
  layout.showDsControls = true;
  reconnectedLayoutSocket.message({v: 2, type: 'layout', layout});
  for (const id of builtInIds) assert.equal(control(id).hidden, false);
  assert(control('dpad').classList.contains('analog'), 'hidden controls retain their appearance');
  assert.equal(control('dpad').style.left, '10%', 'hidden controls retain their geometry');
  assert.equal(layoutPage.document.querySelectorAll('[data-layout-custom]').length, 1);

  const multi = page();
  const controller = multi.sockets[0];
  controller.open();
  controller.message({v: 2, type: 'hello'});
  multi.tick(20);
  const x = multi.document.getElementById('x');
  const a = multi.document.getElementById('a');
  x.fire('pointerdown', {pointerId: 11, isPrimary: true});
  assert.equal(controller.sent.at(-1).buttons, 1 << 10, 'button-down must not wait for a timer');
  a.fire('pointerdown', {pointerId: 12, isPrimary: false});
  assert.equal(controller.sent.at(-1).buttons, (1 << 10) | 1, 'X and A are independently held');
  assert(x.classList.contains('active') && a.classList.contains('active'));
  a.fire('pointerup', {pointerId: 12});
  assert.equal(controller.sent.at(-1).buttons, 1 << 10, 'quick A release preserves held X');
  a.fire('lostpointercapture', {pointerId: 12});
  assert.equal(controller.sent.at(-1).buttons, 1 << 10);
  x.fire('pointerup', {pointerId: 11});
  assert.equal(controller.sent.at(-1).buttons, 0);
  // Each control only releases pointers that it owns. Two contacts on one
  // button and a second button must all remain independent.
  x.fire('pointerdown', {pointerId: 11});
  x.fire('pointerdown', {pointerId: 13, isPrimary: false});
  a.fire('pointerdown', {pointerId: 12, isPrimary: false});
  a.fire('lostpointercapture', {pointerId: 11});
  assert.equal(controller.sent.at(-1).buttons, 0x401);
  x.fire('pointerup', {pointerId: 11});
  assert.equal(controller.sent.at(-1).buttons, 0x401);
  x.fire('pointercancel', {pointerId: 13});
  assert.equal(controller.sent.at(-1).buttons, 1, 'releasing X must preserve held A');
  multi.tick(220);
  assert.equal(controller.sent.at(-1).buttons, 1, 'heartbeat preserves a held button');

  const stylus = multi.document.getElementById('screen');
  stylus.fire('pointerdown', {pointerId: 21, isPrimary: false, clientX: 40, clientY: 50});
  assert.equal(controller.sent.at(-1).buttons, 1);
  assert.deepEqual(controller.sent.at(-1).touch, {active: true, x: 40, y: 50});
  const held = controller.sent.length;
  stylus.fire('pointerdown', {pointerId: 22, clientX: 200, clientY: 150});
  stylus.fire('pointermove', {pointerId: 22, clientX: 210, clientY: 160});
  stylus.fire('pointerup', {pointerId: 22});
  assert.equal(controller.sent.length, held, 'extra canvas finger cannot hijack or release the stylus');
  multi.tick(8);
  stylus.fire('pointermove', {pointerId: 21, clientX: 41, clientY: 51,
    getCoalescedEvents: () => [{clientX: 42, clientY: 52}, {clientX: 43, clientY: 53}]});
  assert.deepEqual(controller.sent.at(-1).touch, {active: true, x: 43, y: 53}, 'use newest coalesced sample');
  stylus.fire('pointerup', {pointerId: 21, clientX: 43, clientY: 53});
  assert.equal(controller.sent.at(-1).touch.active, false);
  assert.equal(controller.sent.at(-1).buttons, 1);
  a.fire('pointerup', {pointerId: 12});
  assert.equal(controller.sent.at(-1).buttons, 0);

  const pad = {index: 0, connected: true, mapping: 'standard',
    buttons: Array.from({length: 16}, () => ({pressed: false})), axes: [0, 0]};
  multi.gamepads[0] = pad;
  pad.buttons[0].pressed = true;
  pad.axes[0] = -1;
  multi.tick(16);
  assert.equal(controller.sent.at(-1).buttons, 1 | (1 << 5), 'gamepad face and stick input reach the bridge');
  assert(multi.document.getElementById('controller').classList.contains('gamepad-mode'));
  const toggle = multi.document.getElementById('virtual-controls');
  assert.equal(toggle.hidden, false);
  toggle.fire('click');
  assert(!multi.document.getElementById('controller').classList.contains('gamepad-mode'));
  assert.equal(controller.sent.at(-1).buttons, 1 | (1 << 5), 'showing controls preserves hardware input');
  x.fire('pointerdown', {pointerId: 44});
  assert.equal(controller.sent.at(-1).buttons, 1 | (1 << 5) | (1 << 10));
  toggle.fire('click');
  assert.equal(controller.sent.at(-1).buttons, 1 | (1 << 5), 'hiding controls releases virtual input only');
  multi.window.fire('blur');
  assert.equal(controller.sent.findLast(message => message.type === 'input').buttons, 0,
    'leaving the page releases held gamepad input');
  multi.window.fire('focus');
  multi.tick(16);
  assert.equal(controller.sent.at(-1).buttons, 1 | (1 << 5), 'returning to the page restores gamepad input');
  pad.buttons[6].pressed = true;
  pad.buttons[4].pressed = true;
  multi.tick(16);
  assert.equal(controller.sent.at(-1).buttons, 1 | (1 << 5) | (1 << 9),
    'DS L uses the trigger rather than the browser-reserved shoulder by default');
  pad.buttons[10].pressed = true;
  multi.tick(16);
  assert(!multi.document.getElementById('controller').classList.contains('gamepad-mode'),
    'left-stick click controls the phone page');
  pad.buttons[10].pressed = false;
  multi.tick(16);
  pad.buttons[11].pressed = true;
  multi.tick(16);
  assert.equal(multi.document.getElementById('gamepad-settings').hidden, false);
  assert.equal(controller.sent.at(-1).buttons, 0, 'editing releases gamepad input');
  pad.buttons[11].pressed = false;
  multi.tick(16);
  pad.buttons[11].pressed = true;
  multi.tick(16);
  assert.equal(multi.document.getElementById('gamepad-settings').hidden, true);
  assert.equal(controller.sent.at(-1).buttons, 1 | (1 << 5) | (1 << 9));
  pad.connected = false;
  multi.tick(16);
  assert.equal(controller.sent.at(-1).buttons, 0, 'unplug releases hardware input');
  assert.equal(toggle.hidden, true);

  const custom = page(false, {
    buttons: ['b2', 'b1', 'b8', 'b9', 'b15', 'b14', 'b12', 'b13', 'b7', 'b6', 'b0', 'b3'],
    customizedButtons: [true, false, false, false, false, false, false, false, false, false, true, false],
    hotkeyRows: [{action: 4, source: 'b6'}], stickAsDpad: true
  });
  const customSocket = custom.sockets[0];
  customSocket.open();
  customSocket.message({v: 2, type: 'hello'});
  const customPad = {index: 0, connected: true, mapping: 'standard',
    buttons: Array.from({length: 16}, () => ({pressed: false})), axes: [0, 0]};
  custom.gamepads[0] = customPad;
  customPad.buttons[2].pressed = true;
  customPad.buttons[6].pressed = true;
  custom.tick(16);
  assert.equal(customSocket.sent.at(-1).buttons, 1 | (1 << 9),
    'saved custom DS mapping loads in a later page session');
  assert.equal(customSocket.sent.at(-1).hotkeys, 1 << 4,
    'saved hotkey mapping loads in a later page session');

  custom.document.getElementById('gamepad-map').fire('click');
  const mapA = custom.document.getElementById('map-0');
  mapA.fire('click');
  custom.tick(16);
  assert.equal(JSON.parse(custom.storage.get('widemelonGamepadMapping')).buttons[0], 'b2',
    'a button already held when capture starts does not replace the binding');
  customPad.buttons[2].pressed = false;
  customPad.buttons[6].pressed = false;
  custom.tick(16);
  customPad.axes[2] = -1;
  custom.tick(16);
  assert.equal(JSON.parse(custom.storage.get('widemelonGamepadMapping')).buttons[0], 'a2-',
    'capture accepts the next input after all controller inputs return to neutral');
  assert(!mapA.classList.contains('waiting'));

  customPad.axes[2] = 0;
  mapA.fire('click');
  custom.tick(16);
  customPad.connected = false;
  custom.tick(16);
  assert(!mapA.classList.contains('waiting'), 'disconnect cancels pending mapping capture');
  customPad.connected = true;
  custom.tick(16);
  customPad.buttons[11].pressed = true;
  custom.tick(16);
  customPad.buttons[11].pressed = false;
  custom.tick(16);
  customPad.buttons[3].pressed = true;
  custom.tick(16);
  assert.equal(JSON.parse(custom.storage.get('widemelonGamepadMapping')).buttons[0], 'a2-',
    'reopening settings after reconnect does not resume an abandoned capture');

  for (const rate of [60, 120, 240]) {
    const motion = page();
    const transport = motion.sockets[0];
    transport.open();
    transport.message({v: 2, type: 'hello'});
    motion.tick(20);
    // Leave JPEG decoding and its acknowledgement unresolved throughout the
    // stroke. Input must progress independently with bounded latest snapshots.
    transport.message(frame(100));
    const surface = motion.document.getElementById('screen');
    const sampledAt = new Map([[0, motion.now()]]);
    const offset = transport.sent.length;
    surface.fire('pointerdown', {pointerId: 31, clientX: 0, clientY: 40});
    for (let position = 1; position <= rate; position++) {
      motion.tick(1000 / rate);
      sampledAt.set(position, motion.now());
      surface.fire('pointermove', {pointerId: 31, clientX: position, clientY: 40});
    }
    motion.tick(8);
    const latest = transport.sent.at(-1);
    assert.equal(latest.touch.x, rate, 'last movement is delivered even when the stroke stops moving');
    const inputs = transport.sent.slice(offset).filter(m => m.type === 'input');
    assert(inputs.length <= 132, 'motion stays below 125 Hz plus heartbeat allowance');
    let maxDelay = 0;
    let previousX = -1;
    transport.sent.slice(offset).forEach((message, index) => {
      if (message.type !== 'input') return;
      assert(message.touch.active && message.touch.x >= previousX, 'no stale or released stroke snapshots');
      // Heartbeats can repeat an already-delivered position. Measure the first
      // delivery of each new position rather than the age of those repeats.
      if (message.touch.x !== previousX)
        maxDelay = Math.max(maxDelay, transport.sentAt[offset + index] - sampledAt.get(message.touch.x));
      previousX = message.touch.x;
    });
    assert(maxDelay <= 8.001, `${rate} Hz motion scheduling delay was ${maxDelay} ms`);
    assert.equal(transport.sent.filter(m => m.type === 'frameAck').length, 0);
    surface.fire('pointerup', {pointerId: 31, clientX: rate, clientY: 40});
    assert.equal(transport.sent.at(-1).touch.active, false, 'stylus release is immediate');
    console.log(`${rate} Hz motion: ${inputs.length} snapshots, maximum added scheduling delay ${maxDelay.toFixed(2)} ms`);
  }

  const p = page(true);
  assert.deepEqual(p.replacedUrls, ['/'], 'QR fragment erased even if storage is disabled');
  let socket = p.sockets[0];
  socket.open();
  p.tick(200);
  assert.equal(socket.sent.length, 1, 'only auth is sent before hello');
  socket.message({v: 2, type: 'hello'});
  p.tick(16);
  const screen = p.document.getElementById('screen');
  screen.fire('pointerdown', {pointerId: 1, clientX: 10, clientY: 20});
  for (let i = 0; i < 1000; i++) screen.fire('pointermove', {pointerId: 1, clientX: 20, clientY: 30});
  const before = socket.sent.length;
  p.tick(16);
  assert.equal(socket.sent.length, before + 1, 'pointer bursts produce one snapshot');
  assert.equal(socket.sent.at(-1).touch.active, true);
  p.window.fire('pagehide');
  assert.equal(socket.sent.at(-2).touch.active, false, 'page exit releases touch immediately');

  socket.message(frame(1));
  socket.message(frame(2));
  socket.message(frame(3));
  assert.equal(p.decodes.length, 1, 'only one decode at a time');
  await decode(p, 1);
  assert.equal(p.decodes.length, 1);
  await decode(p, 3);
  assert.deepEqual(p.draws, [1, 3], 'newest pending frame replaces older pending frame');
  assert.deepEqual(socket.sent.filter(m => m.type === 'frameAck').map(m => m.seq), [1, 3]);

  socket.message(frame(4));
  const stale = socket;
  socket.close();
  p.tick(250);
  socket = p.sockets.at(-1);
  socket.open();
  socket.message({v: 2, type: 'hello'});
  await decode(p, 4);
  assert.deepEqual(p.draws, [1, 3], 'old connection decode must not draw after reconnect');
  assert.equal(socket.sent.filter(m => m.type === 'frameAck').length, 0);
  stale.onclose({reason: 'Authentication failed'});
  p.tick(16);
  assert(socket.sent.some(m => m.type === 'input'), 'stale callbacks cannot deauthorize new connection');
  socket.close('Authentication failed');
  assert.equal(p.document.getElementById('pairing').hidden, false);

  const busy = page();
  for (const delay of [250, 500, 1000, 2000]) {
    const count = busy.sockets.length;
    const candidate = busy.sockets.at(-1);
    candidate.open();
    candidate.close('Pairing unavailable');
    busy.tick(delay - 1);
    assert.equal(busy.sockets.length, count, 'handshake alone must not reset reconnect backoff');
    busy.tick(1);
    assert.equal(busy.sockets.length, count + 1);
  }
  console.log('Phone browser input, decoding, credential storage and reconnect regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
