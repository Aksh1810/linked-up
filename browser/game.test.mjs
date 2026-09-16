import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Babylon from '@babylonjs/core/index.js';

// Exercise the real render-loop and lifecycle code without requiring WebGL in CI.
function renderer() {
  let now = 0, frame, state = null, engine;
  const sent = [], calls = [], handlers = new Map();
  const context = vm.createContext({
    ...Babylon,
    Engine: class extends Babylon.NullEngine {
      constructor() { super({ renderWidth:800, renderHeight:600 }); engine=this; }
      runRenderLoop(callback) { frame=callback; }
    },
    performance: { now: () => now }, document: { getElementById: () => ({}) },
    window: {
      addEventListener(type, callback) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(callback);
      },
      removeEventListener(type, callback) { handlers.get(type)?.delete(callback); }
    }
  });
  const source = readFileSync(new URL('./game.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export (async )?function /g, '$1function ');
  vm.runInContext(source, context);
  return {
    start: () => context.start('canvas', 'blue', {
      async invokeMethodAsync(...args) { calls.push(args); return args[0] === 'Frame' ? state : null; }
    }, {angularSensibilityX:1000,angularSensibilityY:1000,reducedMotion:true}),
    stop: () => context.stop(),
    frame(time) { now = time; return frame(); }, sent, handlers, calls,
    get scene() { return engine.scenes[0]; },
    get camera() { return engine.scenes[0].activeCamera; },
    setSnapshot(value) { state = value; },
    event(type, event = {}) { for (const handler of handlers.get(type) ?? []) handler(event); }
  };
}

test('the rendering bridge forwards frames and raw key events to C#', async () => {
  const game = renderer();
  game.start();
  game.event('keydown', { code: 'KeyW', preventDefault() {} });
  game.event('keyup', { code: 'KeyW', preventDefault() {} });
  game.event('blur');
  await game.frame(100);
  assert.deepEqual(game.calls.slice(0, 3), [
    ['KeyChanged', 'KeyW', true], ['KeyChanged', 'KeyW', false], ['ClearInput']
  ]);
  assert.equal(game.calls[3][0], 'Frame');
  assert.equal(game.calls[3][1], 100);
  assert.equal(game.sent.length, 0);
  game.stop();
});

test('leaving a match removes its keyboard and resize listeners', () => {
  const game = renderer();
  game.start();
  game.stop();
  for (const handlers of game.handlers.values()) assert.equal(handlers.size, 0);
  game.start();
  assert.equal(game.handlers.get('keydown').size, 1);
  game.stop();
});

test('camera follows the local robot and the visible base matches the bounded physics platform', async () => {
  const game = renderer();
  game.start();
  game.setSnapshot({ players: [
    { id: 'blue', position: { x: 1, y: 2, z: 3 }, velocity:{x:0,y:0,z:0}, grounded:true },
    { id: 'orange', position: { x: 4, y: 2, z: 3 }, velocity:{x:0,y:0,z:0}, grounded:true }
  ], obstacles: [], tetherTension: 0 });
  await game.frame(0);
  assert.equal(game.camera.target.x, 1);
  assert.equal(game.camera.target.y, 2.55);
  assert.equal(game.camera.target.z, 3);
  const bounds=game.scene.getMeshByName('bounded-platform').getBoundingInfo().boundingBox;
  assert.equal(bounds.extendSize.x*2,16);
  assert.equal(bounds.extendSize.z*2,16);
  assert.ok(game.scene.getMeshByName('blue-head'));
  assert.equal(game.scene.getMeshByName('energy-tether').getTotalVertices(),13);
  assert.equal(game.calls.some(call=>call[0]==='GameplayStatus'),false);
  game.stop();
});

test('the tether supports four robots and falling-platform warnings remain visible', async () => {
  const game=renderer();game.start();
  game.setSnapshot({players:['blue','orange','green','purple'].map((id,x)=>({id,position:{x,y:1,z:0},velocity:{x:0,y:0,z:0},grounded:true})),
    tetherTension:1, obstacles:[{id:'fall',kind:'fallingPlatform',zone:'construction',phase:'warning',halfExtent:{x:1,y:.3,z:1},position:{x:0,y:3,z:4},rotation:{x:0,y:0,z:0}}]});
  await game.frame(20);
  assert.equal(game.scene.getMeshByName('energy-tether').getTotalVertices(),13);
  assert.equal(game.scene.getMeshByName('fall-warning').isEnabled(),true);
  assert.ok(game.scene.getMeshByName('purple-head'));
  assert.equal(game.calls.some(call=>call[0]==='GameplayStatus'),false);
  game.stop();
});
