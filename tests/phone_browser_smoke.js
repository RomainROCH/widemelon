// Optional real Chromium multi-touch -> production Qt bridge smoke test.
// Copyright (C) 2026 WideMelon contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Node.js 22+: node tests/phone_browser_smoke.js build/tests/phone_bridge_test /usr/bin/chromium
'use strict';
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const {mkdtemp, rm, writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {createInterface} = require('node:readline');
const {setTimeout: delay} = require('node:timers/promises');

async function waitFor(check) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await delay(10);
  }
  throw Error('Timed out waiting for browser/bridge state: ' + check);
}

(async () => {
  assert(process.argv[2] && process.argv[3] && typeof WebSocket === 'function',
    'Usage (Node.js 22+): node tests/phone_browser_smoke.js build/tests/phone_bridge_test /path/to/chromium');
  const profile = await mkdtemp(path.join(tmpdir(), 'widemelon-browser-smoke-'));
  const children = [];
  let cdp;
  const benchmark = process.argv.includes('--benchmark');
  try {
    const bridgeArgs = ['--browser-smoke'];
    if (process.argv.includes('--dialog')) bridgeArgs.push('--benchmark-dialog');
    if (process.argv.includes('--touchscreen-only')) bridgeArgs.push('--touchscreen-only');
    const bridge = spawn(path.resolve(process.argv[2]), bridgeArgs,
      {env: {...process.env, QT_QPA_PLATFORM: 'offscreen'}, stdio: ['ignore', 'pipe', 'pipe']});
    children.push(bridge);
    let url, state;
    let guiMaxMs = 0;
    createInterface({input: bridge.stdout}).on('line', line => {
      const message = JSON.parse(line);
      if (message.url) url = message.url;
      else { state = message; guiMaxMs = Math.max(guiMaxMs, message.guiTickMs || 0); }
    });
    await waitFor(() => url);
    const chrome = spawn(process.argv[3], ['--headless', '--disable-gpu', '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'],
      {stdio: ['ignore', 'ignore', 'pipe']});
    children.push(chrome);
    let endpoint;
    createInterface({input: chrome.stderr}).on('line', line => {
      const match = line.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) endpoint = match[1];
    });
    await waitFor(() => endpoint);
    cdp = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { cdp.onopen = resolve; cdp.onerror = reject; });
    let id = 0;
    const pending = new Map();
    cdp.onmessage = event => {
      const reply = JSON.parse(event.data);
      if (reply.method === 'Fetch.requestPaused') {
        call('Fetch.fulfillRequest', {requestId: reply.params.requestId, responseCode: 200,
          responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}],
          body: benchmarkScript.toString('base64')}, reply.sessionId).catch(error => { throw error; });
        return;
      }
      const callbacks = pending.get(reply.id);
      if (!callbacks) return;
      pending.delete(reply.id);
      if (reply.error) callbacks.reject(Error(JSON.stringify(reply.error)));
      else callbacks.resolve(reply.result);
    };
    function call(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(Error('Chromium command timed out: ' + method));
        }, 3000);
        pending.set(requestId, {
          resolve(value) { clearTimeout(timeout); resolve(value); },
          reject(error) { clearTimeout(timeout); reject(error); }
        });
        cdp.send(JSON.stringify({id: requestId, method, params, sessionId}));
      });
    }
    const {targetId} = await call('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await call('Target.attachToTarget', {targetId, flatten: true});
    const tab = (method, params) => call(method, params, sessionId);
    await tab('Page.enable');
    let benchmarkScript;
    if (benchmark && process.env.WIDEMELON_BENCH_REVISION) {
      assert(/^[a-fA-F0-9]{7,40}$/.test(process.env.WIDEMELON_BENCH_REVISION), 'Benchmark revision must be a commit hash');
      benchmarkScript = execFileSync('git', ['show',
        `${process.env.WIDEMELON_BENCH_REVISION}:src/frontend/qt_sdl/phone/app.js`]);
      await tab('Fetch.enable', {patterns: [{urlPattern: '*/app.js', requestStage: 'Request'}]});
    }
    if (benchmark) {
      await tab('Emulation.setCPUThrottlingRate', {rate: Number(process.env.WIDEMELON_BENCH_CPU || 1)});
      await tab('Page.addScriptToEvaluateOnNewDocument', {source: `
        window.bench = {arrivals: [], decodes: [], draws: [], inputs: 0, ack: 0};
        const NativeSocket = WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', e => {
              if (typeof e.data !== 'string') bench.arrivals.push(performance.now());
            });
          }
          send(data) {
            const message = JSON.parse(data);
            if (message.type === 'input') bench.inputs++;
            if (message.type === 'frameAck') bench.ack++;
            return super.send(data);
          }
        };
        const decode = createImageBitmap;
        window.createImageBitmap = async (...args) => {
          const started = performance.now();
          const bitmap = await decode(...args);
          bench.decodes.push(performance.now() - started);
          return bitmap;
        };
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function(...args) {
          bench.draws.push(performance.now());
          return draw.apply(this, args);
        };
        document.addEventListener('pointerdown', e => { window.benchPointer = e.pointerId; }, true);
      `});
    }
    if (process.argv.includes('--gamepad')) {
      await tab('Page.addScriptToEvaluateOnNewDocument', {source: `
        window.testPad = {index: 0, connected: false, mapping: 'standard',
          buttons: Array.from({length: 16}, () => ({pressed: false})), axes: [0, 0]};
        Object.defineProperty(navigator, 'getGamepads', {value: () => [testPad]});
      `});
    }
    await tab('Emulation.setDeviceMetricsOverride', {width: 932, height: 430, deviceScaleFactor: 1, mobile: true});
    await tab('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
    await tab('Page.navigate', {url});
    await waitFor(() => state?.connected);
    await waitFor(async () => (await tab('Runtime.evaluate', {returnByValue: true,
      expression: "document.getElementById('pairing')?.hidden === true"})).result.value);
    const {result} = await tab('Runtime.evaluate', {returnByValue: true, expression: `
      ['.x', '.a', '#screen'].map(selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return {x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height};
      })`});
    const [x, a, screen] = result.value;
    const point = (id, p) => ({id, x: p.x, y: p.y, radiusX: 4, radiusY: 4, force: 1});
    const fingers = [point(1, x), point(2, a)];
    const touch = (type, touchPoints) => tab('Input.dispatchTouchEvent', {type, touchPoints});
    if (process.argv.includes('--touchscreen-only')) {
      const evaluate = async expression => (await tab('Runtime.evaluate', {expression, returnByValue: true})).result.value;
      const assertLayout = async () => {
        assert.equal(await evaluate(`['dpad', 'face', 'l', 'r', 'start', 'select'].every(id =>
          getComputedStyle(document.querySelector('[data-layout-id="' + id + '"]')).display === 'none')`), true);
        assert.equal(await evaluate(`['screen', 'custom-pause'].every(id =>
          getComputedStyle(document.querySelector('[data-layout-id="' + id + '"]')).display !== 'none')`), true);
      };
      await assertLayout();
      const action = await evaluate(`(() => {
        const r = document.querySelector('[data-layout-id="custom-pause"]').getBoundingClientRect();
        return {x: r.x + r.width / 2, y: r.y + r.height / 2};
      })()`);
      await touch('touchStart', [point(3, screen), point(4, action)]);
      await waitFor(() => state.touch >= 0x80000000 && state.hotkeys === (1 << 2));
      assert.equal(state.keys, 0xFFF);
      const before = state.framesAcked;
      await waitFor(() => state.framesAcked > before + 3);
      if (process.argv.includes('--gamepad')) {
        await evaluate('testPad.connected = true');
        await waitFor(async () => evaluate("document.getElementById('controller').classList.contains('gamepad-mode')"));
        await assertLayout();
        assert.equal(state.hotkeys, 1 << 2, 'custom action remains held when gamepad mode starts');
        await evaluate("document.getElementById('virtual-controls').click()");
        await assertLayout();
        await evaluate('testPad.connected = false');
        await waitFor(async () => evaluate("!document.getElementById('controller').classList.contains('gamepad-mode')"));
        await assertLayout();
      }
      await touch('touchEnd', []);
      await waitFor(() => state.touch === 0 && state.hotkeys === 0);
      const screenshotArg = process.argv.find(value => value.startsWith('--screenshot='));
      if (screenshotArg) {
        const shot = await tab('Page.captureScreenshot', {format: 'png'});
        await writeFile(screenshotArg.slice('--screenshot='.length), Buffer.from(shot.data, 'base64'));
      }
      await tab('Page.reload');
      await waitFor(async () => evaluate("document.getElementById('pairing')?.hidden === true"));
      await assertLayout();
      console.log('Real Chromium touchscreen-only visibility, stylus, custom action, streaming and reload passed');
      return;
    }
    if (benchmark) {
      const evaluate = async expression => (await tab('Runtime.evaluate', {expression, returnByValue: true})).result.value;
      for (const phase of ['idle', 'motion', 'buttons']) {
        if (phase === 'motion') {
          await touch('touchStart', [point(3, screen)]);
          await waitFor(() => state.touch >= 0x80000000);
          await evaluate(`window.benchMove = setInterval(() => {
            const r = document.getElementById('screen').getBoundingClientRect();
            document.getElementById('screen').dispatchEvent(new PointerEvent('pointermove', {
              pointerId: benchPointer, clientX: r.x + r.width * (0.5 + 0.2 * Math.sin(performance.now() / 200)),
              clientY: r.y + r.height / 2
            }));
          }, 1000 / 120)`);
        }
        if (phase === 'buttons') await touch('touchStart', fingers);
        await delay(500);
        const before = {...state};
        guiMaxMs = 0;
        await evaluate('window.bench = {arrivals: [], decodes: [], draws: [], inputs: 0, ack: 0}');
        const start = performance.now();
        await delay(6000);
        const seconds = (performance.now() - start) / 1000;
        const browser = await evaluate('bench');
        const gaps = browser.draws.slice(1).map((value, index) => value - browser.draws[index]).sort((a, b) => a - b);
        const result = {revision: process.env.WIDEMELON_BENCH_REVISION || 'working', phase,
          cpu: process.env.WIDEMELON_BENCH_CPU || '1', dialog: process.argv.includes('--dialog'),
          offeredFps: (state.framesOffered - before.framesOffered) / seconds,
          encodedFps: (state.framesEncoded - before.framesEncoded) / seconds,
          sentFps: (state.framesSent - before.framesSent) / seconds,
          ackedFps: (state.framesAcked - before.framesAcked) / seconds,
          receivedFps: browser.arrivals.length / seconds, displayedFps: browser.draws.length / seconds,
          inputsPerSecond: browser.inputs / seconds, encodeMs: state.encodeMs,
          decodeMs: browser.decodes.reduce((a, b) => a + b, 0) / browser.decodes.length,
          drawGap95Ms: gaps[Math.floor(gaps.length * 0.95)], guiMaxMs};
        console.log(JSON.stringify(result));
        assert(result.offeredFps >= 28.5 && result.offeredFps <= 31, 'test frame source must stay near 30 FPS');
        assert(result.displayedFps >= 28.5, 'stream must stay near 30 FPS during each six-second phase');
        if (phase === 'motion') assert(result.inputsPerSecond >= 20, 'benchmark must actually exercise input');
        await evaluate('clearInterval(window.benchMove)');
        if (phase !== 'idle') await touch('touchEnd', []);
      }
      return;
    }
    await touch('touchStart', [fingers[0]]);
    await waitFor(() => state.keys === (0xFFF ^ 0x400));
    await touch('touchStart', fingers);
    await waitFor(() => state.keys === (0xFFF ^ 0x401));
    await delay(250);
    assert.equal(state.keys, 0xFFF ^ 0x401, 'both buttons remain held during video streaming');
    await touch('touchEnd', [fingers[1]]);
    await waitFor(() => state.keys === (0xFFF ^ 0x400));
    await touch('touchEnd', []);
    await waitFor(() => state.keys === 0xFFF);
    // Hold A while drawing a continuous stroke with a separate finger.
    await touch('touchStart', [fingers[1]]);
    await waitFor(() => state.keys === 0xFFE);
    const stylus = point(3, {x: screen.x - screen.width / 4, y: screen.y});
    await touch('touchStart', [fingers[1], stylus]);
    await waitFor(() => state.touch !== 0);
    let previousX = state.touch & 255;
    for (let step = 1; step <= 30; step++) {
      stylus.x += screen.width / 100;
      await touch('touchMove', [fingers[1], stylus]);
      await waitFor(() => (state.touch & 255) > previousX);
      assert.equal(state.keys, 0xFFE);
      assert(state.touch >= 0x80000000);
      previousX = state.touch & 255;
    }
    await touch('touchEnd', [stylus]);
    await waitFor(() => state.touch === 0);
    assert.equal(state.keys, 0xFFE, 'stylus release preserves held A');
    await touch('touchEnd', []);
    await waitFor(() => state.keys === 0xFFF);
    assert(state.framesAcked > 2, 'video acknowledgement flow continues during touch input');
    if (process.argv.includes('--gamepad')) {
      const evaluate = async expression => (await tab('Runtime.evaluate', {expression, returnByValue: true})).result.value;
      await evaluate('testPad.connected = true; testPad.buttons[0].pressed = true');
      await waitFor(() => state.keys === 0xFFE);
      await waitFor(async () => evaluate("document.getElementById('controller').classList.contains('gamepad-mode')"));
      assert.equal(await evaluate("document.getElementById('virtual-controls').hidden"), false);
      await evaluate("document.getElementById('virtual-controls').click()");
      assert.equal(await evaluate("document.getElementById('controller').classList.contains('gamepad-mode')"), false);
      // Showing the buttons must not discard a held hardware button.
      assert.equal(state.keys, 0xFFE);
      await evaluate('testPad.buttons[0].pressed = false');
      await waitFor(() => state.keys === 0xFFF);
      await evaluate("document.getElementById('gamepad-map').click()");
      assert.equal(await evaluate("document.getElementById('gamepad-settings').hidden"), false);
      assert.equal(await evaluate("document.getElementById('gamepad-settings').scrollHeight <= document.getElementById('gamepad-settings').clientHeight"), true,
        'controller settings must fit the phone viewport without outer overflow');
      assert.equal(await evaluate("document.querySelector('#controller-diagram [data-ds-bit=\"0\"]').classList.contains('mapped')"), false,
        'default bindings stay neutral until the user remaps them');
      await evaluate("document.querySelector('#controller-diagram [data-ds-bit=\"0\"]').dispatchEvent(new MouseEvent('click', {bubbles:true}))");
      await delay(50);
      await evaluate('testPad.buttons[2].pressed = true');
      await waitFor(async () => evaluate("JSON.parse(localStorage.getItem('widemelonGamepadMapping')).buttons[0] === 'b2'"));
      assert.equal(await evaluate("document.querySelector('#controller-diagram [data-ds-bit=\"0\"]').classList.contains('mapped')"), true,
        'newly mapped DS buttons are marked green');
      await evaluate('testPad.buttons[2].pressed = false');
      await evaluate("document.querySelector('#gamepad-hotkeys .hotkey-tile').click(); document.getElementById('hotkey-editor-bind').click()");
      await delay(50);
      await evaluate('testPad.buttons[4].pressed = true');
      await waitFor(async () => evaluate("JSON.parse(localStorage.getItem('widemelonGamepadMapping')).hotkeyRows[0].source === 'b4'"));
      await evaluate("document.getElementById('hotkey-editor-done').click()");
      assert.equal(await evaluate("document.querySelector('#gamepad-hotkeys .hotkey-tile').classList.contains('mapped')"), true,
        'mapped hotkeys are marked green');
      await evaluate("document.getElementById('add-gamepad-hotkey').click()");
      assert.equal(await evaluate("document.querySelectorAll('#gamepad-hotkeys .hotkey-tile').length"), 2);
      assert.equal(await evaluate("document.getElementById('hotkey-editor').hidden"), false,
        'adding a hotkey opens its compact editor');
      await evaluate("document.getElementById('hotkey-editor-remove').click()");
      assert.equal(await evaluate("document.querySelectorAll('#gamepad-hotkeys .hotkey-tile').length"), 1);
      const screenshotArg = process.argv.find(value => value.startsWith('--screenshot='));
      if (screenshotArg) {
        const shot = await tab('Page.captureScreenshot', {format: 'png'});
        await writeFile(screenshotArg.slice('--screenshot='.length), Buffer.from(shot.data, 'base64'));
      }
      await evaluate('testPad.buttons[4].pressed = false');
      await evaluate("document.getElementById('gamepad-close').click()");
      await evaluate("document.getElementById('virtual-controls').click()");
      await waitFor(async () => evaluate("document.getElementById('controller').classList.contains('gamepad-mode')"));
      await touch('touchStart', [point(4, screen)]);
      await waitFor(() => state.touch >= 0x80000000);
      assert.equal(state.keys, 0xFFF, 'the screen remains touchable in gamepad mode');
      await touch('touchEnd', []);
      await waitFor(() => state.touch === 0);
      await evaluate('testPad.connected = false');
      await waitFor(() => state.keys === 0xFFF);
      await waitFor(async () => evaluate("!document.getElementById('controller').classList.contains('gamepad-mode')"));
      assert.equal(await evaluate("document.getElementById('virtual-controls').hidden"), true);
    }
    console.log('Real Chromium multi-touch and continuous stylus input passed through the production WebSocket bridge');
  } finally {
    cdp?.close();
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
