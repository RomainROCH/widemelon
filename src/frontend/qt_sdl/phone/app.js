// Copyright (C) 2026 WideMelon contributors
// SPDX-License-Identifier: GPL-3.0-or-later

(() => {
  'use strict';
  const status = document.getElementById('status');
  const metrics = document.getElementById('metrics');
  const hud = document.getElementById('hud');
  const canvas = document.getElementById('screen');
  const context = canvas.getContext('2d', {alpha: false});
  const dpad = document.getElementById('dpad');
  const controller = document.getElementById('controller');
  const virtualControls = document.getElementById('virtual-controls');
  const gamepadMap = document.getElementById('gamepad-map');
  const gamepadSettings = document.getElementById('gamepad-settings');
  const gamepadHotkeys = document.getElementById('gamepad-hotkeys');
  const hotkeyEditor = document.getElementById('hotkey-editor');
  const hotkeyEditorBind = document.getElementById('hotkey-editor-bind');
  const hotkeyEditorAction = document.getElementById('hotkey-editor-action');
  const mappingPrompt = document.getElementById('mapping-prompt');
  gamepadSettings.hidden = true;
  const pairing = document.getElementById('pairing');
  const pairingForm = document.getElementById('pairing-form');
  const pairingCode = document.getElementById('pairing-code');
  const pointers = new Map();
  let socket = null;
  let buttons = 0;
  let gamepadButtons = 0;
  let gamepadHotkeyMask = 0;
  let gamepadIndex = null;
  let showVirtualControls = false;
  let inputSuspended = false;
  let hotkeys = 0;
  let touch = {active: false, x: 0, y: 0};
  let reconnectDelay = 250;
  let frames = 0;
  let lastFpsAt = performance.now();
  let displayedFps = 0;
  let inputSequence = 0;
  let credential = '';
  let authenticated = false;
  let reconnectTimer = null;
  let inputTimer = null;
  let lastInputSentAt = -Infinity;
  let touchPointerId = null;
  let pendingFrame = null;
  let decoding = false;

  const dsLabels = ['A', 'B', 'Select', 'Start', 'Right', 'Left', 'Up', 'Down', 'R', 'L', 'X', 'Y'];
  const defaultMapping = ['b0', 'b1', 'b8', 'b9', 'b15', 'b14', 'b12', 'b13', 'b7', 'b6', 'b2', 'b3'];
  const sourceLabels = new Map([
    ['none', 'Not mapped'], ['b0', 'A / bottom'], ['b1', 'B / right'],
    ['b2', 'X / left'], ['b3', 'Y / top'],
    ['b4', 'Left shoulder'], ['b5', 'Right shoulder'],
    ['b6', 'Left trigger'], ['b7', 'Right trigger'],
    ['b8', 'Select / View'], ['b9', 'Start / Menu'], ['b10', 'Left stick click'],
    ['b11', 'Right stick click'], ['b12', 'D-pad up'], ['b13', 'D-pad down'],
    ['b14', 'D-pad left'], ['b15', 'D-pad right'],
    ['a0-', 'Left stick left'], ['a0+', 'Left stick right'],
    ['a1-', 'Left stick up'], ['a1+', 'Left stick down'],
    ['a2-', 'Right stick left'], ['a2+', 'Right stick right'],
    ['a3-', 'Right stick up'], ['a3+', 'Right stick down']
  ]);
  const hotkeyActions = [
    [2, 'Pause / resume', 'Pause'], [3, 'Reset', 'Reset'], [11, 'Frame step', 'Frame step'],
    [4, 'Fast forward', 'Fast Forward'], [17, 'Toggle fast forward', 'Fast F toggle'],
    [16, 'Slow motion', 'Slow motion'], [18, 'Toggle slow motion', 'Slow toggle'],
    [5, 'Toggle FPS limit', 'FPS limit'], [6, 'Desktop fullscreen', 'Fullscreen'],
    [7, 'Swap screens', 'Swap screens'], [8, 'Swap screen emphasis', 'Swap emphasis'],
    [0, 'Close / open lid', 'Lid'], [1, 'Microphone', 'Mic'], [15, 'Toggle audio mute', 'Mute'],
    [12, 'DSi power', 'DSi power'], [13, 'DSi volume up', 'Volume +'], [14, 'DSi volume down', 'Volume −']
  ];
  const validHotkeys = new Set(hotkeyActions.map(([id]) => id));
  const idleMappingPrompt = 'Select a control, then press a button on your controller.';
  mappingPrompt.textContent = idleMappingPrompt;
  const pageMapping = ['b10', 'b11'];
  let gamepadMapping = [...defaultMapping];
  let customizedButtons = Array(12).fill(false);
  let stickAsDpad = true;
  let hotkeyRows = [{id: 1, action: 4, source: 'none'}];
  let lastPagePressed = [false, false];
  let capture = null;
  let editorRowId = null;

  try {
    const saved = JSON.parse(localStorage.getItem('widemelonGamepadMapping') || 'null');
    if (Array.isArray(saved?.buttons) && saved.buttons.length === 12
        && saved.buttons.every(value => sourceLabels.has(value))) {
      gamepadMapping = saved.buttons;
      customizedButtons = Array.isArray(saved.customizedButtons) && saved.customizedButtons.length === 12
          && saved.customizedButtons.every(value => typeof value === 'boolean')
        ? saved.customizedButtons
        : saved.buttons.map((value, index) => value !== defaultMapping[index]);
      stickAsDpad = saved.stickAsDpad !== false;
      if (Array.isArray(saved.hotkeyRows) && saved.hotkeyRows.length > 0 && saved.hotkeyRows.length <= hotkeyActions.length) {
        if (saved.hotkeyRows.every(row => validHotkeys.has(row?.action) && sourceLabels.has(row?.source))) {
          hotkeyRows = saved.hotkeyRows.map((row, index) => ({id: index + 1, action: row.action, source: row.source}));
          if (hotkeyRows.length === 1 && hotkeyRows[0].source === 'none' && hotkeyRows[0].action === 17)
            hotkeyRows[0].action = 4;
        }
      } else if (Array.isArray(saved.hotkeys) && saved.hotkeys.length === 23) {
        const rows = hotkeyActions.filter(([id]) => sourceLabels.has(saved.hotkeys[id]) && saved.hotkeys[id] !== 'none')
          .map(([action], index) => ({id: index + 1, action, source: saved.hotkeys[action]}));
        if (rows.length) hotkeyRows = rows;
      }
    }
  } catch (_) {}
  let nextHotkeyRowId = hotkeyRows.length + 1;

  function saveGamepadMapping() {
    const savedRows = hotkeyRows.map(({action, source}) => ({action, source}));
    try { localStorage.setItem('widemelonGamepadMapping', JSON.stringify({buttons: gamepadMapping, customizedButtons, hotkeyRows: savedRows, stickAsDpad})); }
    catch (_) {}
  }

  function clearCapture(message = idleMappingPrompt) {
    capture?.element?.classList.remove('waiting');
    capture = null;
    mappingPrompt.textContent = message;
  }

  function armCapture(kind, id, element, label) {
    clearCapture();
    capture = {kind, id, element, label, ready: false};
    element.classList.add('waiting');
    mappingPrompt.textContent = `Release the controller, then press the button for ${label}.`;
  }

  function renderDiagram() {
    document.querySelectorAll('#controller-diagram .map-target').forEach(target => {
      const bit = Number(target.dataset.dsBit);
      target.classList.toggle('mapped', customizedButtons[bit]);
    });
  }

  function renderHotkeys() {
    gamepadHotkeys.innerHTML = hotkeyRows.map(row => `
      <button class="hotkey-tile${row.source === 'none' ? '' : ' mapped'}" data-row-id="${row.id}" type="button">
        ${shortActionLabel(row.action)}
      </button>`).join('');
    document.querySelectorAll('#gamepad-hotkeys .hotkey-tile').forEach(tile => {
      tile.addEventListener('click', () => openHotkeyEditor(Number(tile.dataset.rowId)));
    });
  }

  function shortActionLabel(action) {
    return hotkeyActions.find(([id]) => id === action)?.[2] || 'Set action';
  }

  function openHotkeyEditor(rowId) {
    const row = hotkeyRows.find(value => value.id === rowId);
    if (!row) return;
    clearCapture();
    editorRowId = rowId;
    hotkeyEditorAction.value = String(row.action);
    hotkeyEditorBind.textContent = sourceLabels.get(row.source) || 'Press a controller button';
    hotkeyEditor.hidden = false;
  }

  hotkeyEditorAction.innerHTML = hotkeyActions.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
  hotkeyEditorAction.addEventListener('change', () => {
    const row = hotkeyRows.find(value => value.id === editorRowId);
    if (!row) return;
    row.action = Number(hotkeyEditorAction.value);
    renderHotkeys();
    saveGamepadMapping();
  });
  hotkeyEditorBind.addEventListener('click', () => {
    const row = hotkeyRows.find(value => value.id === editorRowId);
    if (row) armCapture('hotkey', row.id, hotkeyEditorBind,
      hotkeyActions.find(([id]) => id === row.action)?.[1] || 'hotkey');
  });
  document.getElementById('hotkey-editor-done').addEventListener('click', () => {
    clearCapture();
    hotkeyEditor.hidden = true;
  });
  document.getElementById('hotkey-editor-remove').addEventListener('click', () => {
    clearCapture();
    hotkeyRows = hotkeyRows.filter(value => value.id !== editorRowId);
    if (!hotkeyRows.length) hotkeyRows.push({id: nextHotkeyRowId++, action: 4, source: 'none'});
    editorRowId = null;
    hotkeyEditor.hidden = true;
    renderHotkeys();
    saveGamepadMapping();
  });

  document.querySelectorAll('#controller-diagram .map-target').forEach(target => {
    const bit = Number(target.dataset.dsBit);
    const arm = () => armCapture('ds', bit, target, `DS ${dsLabels[bit]}`);
    target.addEventListener('click', arm);
    target.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') arm(); });
    target.setAttribute('tabindex', '0');
  });
  document.getElementById('add-gamepad-hotkey').addEventListener('click', () => {
    if (hotkeyRows.length >= hotkeyActions.length) return;
    const used = new Set(hotkeyRows.map(row => row.action));
    const action = hotkeyActions.find(([id]) => !used.has(id))?.[0] ?? 17;
    const row = {id: nextHotkeyRowId++, action, source: 'none'};
    hotkeyRows.push(row);
    renderHotkeys();
    saveGamepadMapping();
    gamepadHotkeys.scrollTop = gamepadHotkeys.scrollHeight;
    openHotkeyEditor(row.id);
  });
  document.getElementById('gamepad-reset').addEventListener('click', () => {
    gamepadMapping = [...defaultMapping];
    customizedButtons = Array(12).fill(false);
    hotkeyRows = [{id: nextHotkeyRowId++, action: 4, source: 'none'}];
    stickAsDpad = true;
    clearCapture('Default mapping restored.');
    renderDiagram();
    renderHotkeys();
    saveGamepadMapping();
  });
  function setGamepadSettingsVisible(visible) {
    clearCapture();
    hotkeyEditor.hidden = true;
    if (visible) {
      renderDiagram();
      renderHotkeys();
    }
    gamepadSettings.hidden = !visible;
  }

  document.getElementById('gamepad-close').addEventListener('click', () => setGamepadSettingsVisible(false));
  gamepadMap.addEventListener('click', () => setGamepadSettingsVisible(true));
  renderDiagram();
  renderHotkeys();

  function rememberCredential(value) {
    // Storage can be disabled even when the page and WebSocket are usable.
    try {
      if (value) sessionStorage.setItem('widemelonPairing', value);
      else sessionStorage.removeItem('widemelonPairing');
    } catch (_) {}
  }

  function send(type, extra = {}) {
    if (authenticated && socket && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({v: 2, type, ...extra}));
  }

  function sendInputNow() {
    clearTimeout(inputTimer);
    inputTimer = null;
    if (authenticated) {
      lastInputSentAt = performance.now();
      send('input', {seq: ++inputSequence, buttons, hotkeys, touch});
    }
  }

  function sendInput() {
    // Send normal 60/120 Hz movement immediately. Faster event bursts keep
    // only the newest position, with at most 8 ms of added scheduling delay.
    // Button and touch transitions bypass this motion-only rate limit.
    const delay = 8 - (performance.now() - lastInputSentAt);
    if (delay <= 0) sendInputNow();
    else if (inputTimer === null) inputTimer = setTimeout(sendInputNow, delay);
  }

  function recalculateButtons(immediate = false) {
    let value = 0;
    let hotkeyValue = 0;
    for (const pointer of pointers.values()) {
      value |= pointer.bits || 0;
      hotkeyValue |= pointer.hotkeys || 0;
    }
    buttons = value | gamepadButtons;
    hotkeys = hotkeyValue | gamepadHotkeyMask;
    document.querySelectorAll('[data-button], [data-hotkey]').forEach(el => {
      const active = el.dataset.button !== undefined
        ? (buttons & (1 << Number(el.dataset.button))) !== 0
        : (hotkeys & (1 << Number(el.dataset.hotkey))) !== 0;
      el.classList.toggle('active', active);
    });
    if (immediate) sendInputNow();
    else sendInput();
  }

  function setGamepadMode(connected) {
    virtualControls.hidden = !connected;
    gamepadMap.hidden = !connected;
    if (!connected) {
      setGamepadSettingsVisible(false);
      showVirtualControls = false;
    }
    const hideControls = connected && !showVirtualControls;
    controller.classList.toggle('gamepad-mode', hideControls);
    virtualControls.textContent = hideControls ? 'Show controls' : 'Hide controls';
    const label = hideControls ? 'Show touch controls' : 'Hide touch controls';
    virtualControls.setAttribute('aria-label', label);
    virtualControls.title = label;
    if (hideControls && pointers.size) {
      for (const [id, pointer] of pointers) {
        if (!controller.classList.contains('touchscreen-only') || pointer.element.dataset.hotkey === undefined)
          pointers.delete(id);
      }
      dpad.classList.remove('active');
      dpad.style.setProperty('--stick-x', '0px');
      dpad.style.setProperty('--stick-y', '0px');
      recalculateButtons(true);
    }
  }

  function toggleVirtualControls() {
    showVirtualControls = !showVirtualControls;
    setGamepadMode(gamepadIndex !== null);
  }
  virtualControls.addEventListener('click', toggleVirtualControls);

  function readGamepadButtons(pad) {
    let bits = 0;
    for (let bit = 0; bit < 12; bit++) {
      if (sourcePressed(pad, gamepadMapping[bit])) bits |= 1 << bit;
    }
    if (stickAsDpad) {
      const x = pad.axes[0] || 0;
      const y = pad.axes[1] || 0;
      if (x > 0.5) bits |= 1 << 4;
      if (x < -0.5) bits |= 1 << 5;
      if (y < -0.5) bits |= 1 << 6;
      if (y > 0.5) bits |= 1 << 7;
    }
    return bits;
  }

  function readGamepadHotkeys(pad) {
    let value = 0;
    for (const row of hotkeyRows) {
      if (sourcePressed(pad, row.source)) value |= 1 << row.action;
    }
    return value;
  }

  function sourcePressed(pad, source) {
    if (source.startsWith('b')) return !!pad.buttons[Number(source.slice(1))]?.pressed;
    if (source.startsWith('a')) {
      const value = pad.axes[Number(source[1])] || 0;
      return source[2] === '+' ? value > 0.5 : value < -0.5;
    }
    return false;
  }

  function finishCapture(source) {
    if (!capture) return;
    const completed = capture;
    if (completed.kind === 'ds') {
      gamepadMapping[completed.id] = source;
      customizedButtons[completed.id] = true;
    }
    else {
      const row = hotkeyRows.find(value => value.id === completed.id);
      if (row) row.source = source;
    }
    saveGamepadMapping();
    clearCapture(`Mapped ${completed.label} to ${sourceLabels.get(source)}.`);
    renderDiagram();
    renderHotkeys();
    if (completed.kind === 'hotkey' && editorRowId === completed.id)
      hotkeyEditorBind.textContent = sourceLabels.get(source) || 'Press a controller button';
  }

  function processPageButtons(pad) {
    for (let index = 0; index < 2; index++) {
      const pressed = pad ? sourcePressed(pad, pageMapping[index]) : false;
      if (pressed && !lastPagePressed[index]) {
        if (index === 0) toggleVirtualControls();
        else setGamepadSettingsVisible(gamepadSettings.hidden);
      }
      lastPagePressed[index] = pressed;
    }
  }

  function pollGamepad() {
    let pads = [];
    if (!inputSuspended && !document.hidden && typeof navigator.getGamepads === 'function') {
      try { pads = navigator.getGamepads() || []; } catch (_) {}
    }
    let pad = gamepadIndex === null ? null : pads[gamepadIndex];
    if (!pad?.connected || pad.mapping !== 'standard') {
      pad = Array.from(pads).find(value => value?.connected && value.mapping === 'standard') || null;
    }
    const nextIndex = pad?.index ?? null;
    if (nextIndex !== gamepadIndex) {
      gamepadIndex = nextIndex;
      setGamepadMode(pad !== null);
    }
    if (capture && pad && !gamepadSettings.hidden) {
      const source = [...sourceLabels.keys()].find(value => sourcePressed(pad, value));
      if (!capture.ready && !source) {
        capture.ready = true;
        mappingPrompt.textContent = `Press the controller button for ${capture.label}.`;
      } else if (capture.ready && source) finishCapture(source);
    } else processPageButtons(pad);
    const nextButtons = pad && gamepadSettings.hidden ? readGamepadButtons(pad) : 0;
    const nextHotkeys = pad && gamepadSettings.hidden ? readGamepadHotkeys(pad) : 0;
    if (nextButtons !== gamepadButtons || nextHotkeys !== gamepadHotkeyMask) {
      gamepadButtons = nextButtons;
      gamepadHotkeyMask = nextHotkeys;
      recalculateButtons(true);
    }
    requestAnimationFrame(pollGamepad);
  }
  requestAnimationFrame(pollGamepad);

  function bindButton(button) {
    if (button.dataset.inputBound) return;
    button.dataset.inputBound = '1';
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, {
        element: button,
        bits: button.dataset.button === undefined ? 0 : 1 << Number(button.dataset.button),
        hotkeys: button.dataset.hotkey === undefined ? 0 : 1 << Number(button.dataset.hotkey)
      });
      recalculateButtons(true);
    });
    const release = event => {
      if (pointers.get(event.pointerId)?.element !== button) return;
      pointers.delete(event.pointerId);
      recalculateButtons(true);
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
  }
  document.querySelectorAll('[data-button]').forEach(bindButton);

  function applyLayout(layout) {
    if (!layout || (layout.version !== 1 && layout.version !== 2) || !Array.isArray(layout.items)) return;
    releaseAll();
    hud.hidden = layout.showHud === false;
    controller.classList.toggle('touchscreen-only', layout.showDsControls === false);
    document.querySelectorAll('[data-layout-custom]').forEach(element => element.remove());
    document.querySelectorAll('[data-layout-id]').forEach(element => { element.hidden = true; });
    for (const item of layout.items) {
      if (!item || typeof item.id !== 'string') continue;
      let element = document.querySelector(`[data-layout-id="${CSS.escape(item.id)}"]`);
      if (!element && item.kind === 'button' && Number.isInteger(item.hotkey)) {
        element = document.createElement('button');
        element.className = 'custom';
        element.dataset.layoutCustom = '1';
        element.dataset.layoutId = item.id;
        element.dataset.hotkey = String(item.hotkey);
        element.textContent = String(item.label || 'Action').slice(0, 24);
        element.setAttribute('aria-label', element.textContent);
        document.getElementById('controller').appendChild(element);
        bindButton(element);
      }
      if (!element) continue;
      const builtInDsControl = ['dpad', 'face', 'l', 'r', 'start', 'select'].includes(item.id);
      element.hidden = layout.showDsControls === false && builtInDsControl;
      if (item.id === 'dpad') element.classList.toggle('analog', item.appearance === 'analog');
      if (item.kind === 'button' && typeof item.label === 'string') {
        element.textContent = item.label.slice(0, 24);
        element.setAttribute('aria-label', element.textContent);
      }
      for (const [property, value] of [['left', item.x], ['top', item.y], ['width', item.w], ['height', item.h]]) {
        if ((item.kind === 'screen' || item.kind === 'directional' || item.kind === 'face') && property === 'height') continue;
        if (typeof value === 'number' && Number.isFinite(value)) element.style[property] = `${value * 100}%`;
      }
      if (item.kind === 'screen') {
        element.style.aspectRatio = '4 / 3';
        element.style.height = 'auto';
      } else if (item.kind === 'directional' || item.kind === 'face') {
        element.style.aspectRatio = '1 / 1';
        element.style.height = 'auto';
      }
    }
  }

  function dpadBits(event) {
    const rect = dpad.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    if (dpad.classList.contains('analog')) {
      if (Math.hypot(x, y) < 0.075) return 0;
      const directions = [
        1 << 4,
        (1 << 4) | (1 << 7),
        1 << 7,
        (1 << 7) | (1 << 5),
        1 << 5,
        (1 << 5) | (1 << 6),
        1 << 6,
        (1 << 6) | (1 << 4)
      ];
      const octant = (Math.round(Math.atan2(y, x) / (Math.PI / 4)) + 8) % 8;
      return directions[octant];
    }
    let value = 0;
    if (Math.abs(x) > 0.12) value |= 1 << (x > 0 ? 4 : 5);
    if (Math.abs(y) > 0.12) value |= 1 << (y > 0 ? 7 : 6);
    return value;
  }
  function updateDirectionalVisual(event) {
    if (!dpad.classList.contains('analog')) return;
    const rect = dpad.getBoundingClientRect();
    let x = (event.clientX - rect.left) / rect.width - 0.5;
    let y = (event.clientY - rect.top) / rect.height - 0.5;
    const length = Math.hypot(x, y);
    if (length > 0.45) { x *= 0.45 / length; y *= 0.45 / length; }
    dpad.style.setProperty('--stick-x', `${x * rect.width * 0.42}px`);
    dpad.style.setProperty('--stick-y', `${y * rect.height * 0.42}px`);
  }
  dpad.addEventListener('pointerdown', event => {
    event.preventDefault();
    dpad.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, {bits: dpadBits(event), element: dpad});
    updateDirectionalVisual(event);
    dpad.classList.add('active');
    recalculateButtons(true);
  });
  dpad.addEventListener('pointermove', event => {
    const value = pointers.get(event.pointerId);
    if (!value || value.element !== dpad) return;
    updateDirectionalVisual(event);
    const bits = dpadBits(event);
    if (value.bits === bits) return;
    value.bits = bits;
    recalculateButtons();
  });
  const releaseDpad = event => {
    if (pointers.get(event.pointerId)?.element !== dpad) return;
    pointers.delete(event.pointerId);
    recalculateButtons(true);
    if ([...pointers.values()].some(pointer => pointer.element === dpad)) return;
    dpad.classList.remove('active');
    dpad.style.setProperty('--stick-x', '0px');
    dpad.style.setProperty('--stick-y', '0px');
  };
  dpad.addEventListener('pointerup', releaseDpad);
  dpad.addEventListener('pointercancel', releaseDpad);
  dpad.addEventListener('lostpointercapture', releaseDpad);

  function updateTouch(event, active, immediate = false) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) * 256 / rect.width);
    const y = Math.floor((event.clientY - rect.top) * 192 / rect.height);
    touch = {active, x: Math.max(0, Math.min(255, x)), y: Math.max(0, Math.min(191, y))};
    if (immediate) sendInputNow();
    else sendInput();
  }
  canvas.addEventListener('pointerdown', event => {
    event.preventDefault();
    // A DS has one stylus. Another finger must not move or release the active
    // stroke, including when the first finger is holding a virtual button.
    if (touchPointerId !== null) return;
    touchPointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    updateTouch(event, true, true);
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== touchPointerId) return;
    const samples = event.getCoalescedEvents?.();
    updateTouch(samples?.length ? samples[samples.length - 1] : event, true);
  });
  const releaseTouch = event => {
    if (event.pointerId !== touchPointerId) return;
    touchPointerId = null;
    updateTouch(event, false, true);
  };
  canvas.addEventListener('pointerup', releaseTouch);
  canvas.addEventListener('pointercancel', releaseTouch);
  canvas.addEventListener('lostpointercapture', releaseTouch);

  function releaseAll() {
    pointers.clear();
    gamepadButtons = 0;
    gamepadHotkeyMask = 0;
    buttons = 0;
    hotkeys = 0;
    touch = {active: false, x: 0, y: 0};
    touchPointerId = null;
    recalculateButtons(true);
    dpad.classList.remove('active');
    dpad.style.setProperty('--stick-x', '0px');
    dpad.style.setProperty('--stick-y', '0px');
    send('visibility', {hidden: true});
  }

  async function displayFrame(buffer, source) {
    pendingFrame = {buffer, source};
    if (decoding) return;
    decoding = true;
    try {
      while (pendingFrame) {
        const next = pendingFrame;
        pendingFrame = null;
        await decodeFrame(next.buffer, next.source);
      }
    } finally { decoding = false; }
  }

  async function decodeFrame(buffer, source) {
    if (source !== socket || !authenticated) return;
    if (buffer.byteLength < 24) return;
    const view = new DataView(buffer);
    if (view.getUint32(0, false) !== 0x574d4632 || view.getUint8(20) !== 1) return;
    const sequence = view.getUint32(4, true);
    const decodeStarted = performance.now();
    try {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(buffer, 24)], {type: 'image/jpeg'}));
      if (source !== socket || !authenticated) { bitmap.close(); return; }
      context.imageSmoothingEnabled = false;
      context.drawImage(bitmap, 0, 0, 256, 192);
      bitmap.close();
      frames++;
      const now = performance.now();
      if (now - lastFpsAt >= 1000) {
        displayedFps = frames * 1000 / (now - lastFpsAt);
        frames = 0;
        lastFpsAt = now;
        metrics.textContent = `${displayedFps.toFixed(1)} FPS · frame ${sequence}`;
      }
      send('frameAck', {seq: sequence, decodeMs: Math.round((performance.now() - decodeStarted) * 10) / 10});
    } catch (error) {
      if (source !== socket || !authenticated) return;
      metrics.textContent = `Decode error: ${error.message}`;
      send('frameAck', {seq: sequence});
    }
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) return;
    if (!credential) {
      pairing.hidden = false;
      status.textContent = 'Enter pairing code';
      return;
    }
    const url = `ws://${location.host}/bridge`;
    status.textContent = 'Connecting paired session…';
    authenticated = false;
    const source = new WebSocket(url);
    socket = source;
    source.binaryType = 'arraybuffer';
    source.onopen = () => {
      if (source !== socket) return;
      status.textContent = 'Authenticating…';
      source.send(JSON.stringify({v: 2, type: 'auth', credential}));
    };
    source.onmessage = event => {
      if (source !== socket) return;
      if (typeof event.data !== 'string') {
        if (authenticated) displayFrame(event.data, source);
        return;
      }
      try {
        const message = JSON.parse(event.data);
        if (message.v !== 2) return;
        if (message.type === 'hello') {
          authenticated = true;
          inputSequence = 0;
          reconnectDelay = 250;
          pairing.hidden = true;
          status.textContent = 'Connected';
          sendInput();
        }
        if ((message.type === 'hello' || message.type === 'layout') && message.layout)
          applyLayout(message.layout);
        if (message.type === 'ping') send('pong', {sent: message.sent});
      } catch (_) {}
    };
    source.onclose = event => {
      if (source !== socket) return;
      releaseAll();
      authenticated = false;
      socket = null;
      pendingFrame = null;
      if (event.reason === 'Authentication failed' || event.reason === 'Pairing changed') {
        credential = '';
        rememberCredential('');
        pairing.hidden = false;
        status.textContent = event.reason === 'Pairing changed' ? 'Pairing code changed' : 'Pairing failed';
        pairingCode.focus();
      } else {
        status.textContent = 'Disconnected; retrying…';
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(5000, reconnectDelay * 2);
      }
    };
    source.onerror = () => { if (source === socket) status.textContent = 'Connection error'; };
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { inputSuspended = true; releaseAll(); }
    else { inputSuspended = false; sendInput(); }
  });
  window.addEventListener('blur', () => { inputSuspended = true; releaseAll(); });
  window.addEventListener('focus', () => { inputSuspended = false; sendInput(); });
  window.addEventListener('contextmenu', event => event.preventDefault());
  window.addEventListener('pagehide', () => { inputSuspended = true; releaseAll(); });
  setInterval(sendInputNow, 200);
  const fullscreenButton = document.getElementById('fullscreen');
  fullscreenButton.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  });
  document.addEventListener('fullscreenchange', () => {
    const label = document.fullscreenElement ? 'Exit full screen' : 'Enter full screen';
    fullscreenButton.setAttribute('aria-label', label);
    fullscreenButton.title = label;
  });
  const fragment = new URLSearchParams(location.hash.slice(1)).get('pair') || '';
  if (/^[A-Za-z0-9_-]{43}$/.test(fragment)) {
    credential = fragment;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    rememberCredential(credential);
  } else {
    try { credential = sessionStorage.getItem('widemelonPairing') || ''; } catch (_) {}
  }
  pairingForm.addEventListener('submit', event => {
    event.preventDefault();
    const code = pairingCode.value.replace(/\D/g, '');
    if (!/^\d{10}$/.test(code)) return;
    credential = code;
    rememberCredential(credential);
    pairingCode.value = '';
    pairing.hidden = true;
    connect();
  });
  connect();
})();
