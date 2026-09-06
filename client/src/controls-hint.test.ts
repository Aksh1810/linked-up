import assert from "node:assert/strict";
import test from "node:test";

import { controlsHintVisible } from "./controls-hint.ts";

test("controls hint is shown until the player dismisses it", () => {
  const storage = new Map<string, string>();
  const store = { getItem: (key: string) => storage.get(key) ?? null };
  assert.equal(controlsHintVisible(store), true);
  storage.set("linked-up.controls-seen", "1");
  assert.equal(controlsHintVisible(store), false);
});
