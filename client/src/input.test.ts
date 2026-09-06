import assert from "node:assert/strict";
import test from "node:test";

import { InputController } from "./input.ts";

const keyboardEvent = (type: "keydown" | "keyup", code: string): KeyboardEvent =>
  Object.assign(new Event(type), { code, repeat: false }) as KeyboardEvent;

test("Space stays held after its one-shot jump press is consumed", () => {
  const originalWindow = globalThis.window;
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  try {
    const input = new InputController();
    target.dispatchEvent(keyboardEvent("keydown", "Space"));
    assert.deepEqual(input.consume(), { x: 0, z: 0, jumpPressed: true, jumpHeld: true });
    assert.deepEqual(input.consume(), { x: 0, z: 0, jumpPressed: false, jumpHeld: true });
    target.dispatchEvent(keyboardEvent("keyup", "Space"));
    assert.deepEqual(input.consume(), { x: 0, z: 0, jumpPressed: false, jumpHeld: false });
    input.dispose();
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
