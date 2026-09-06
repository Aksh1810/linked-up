import assert from "node:assert/strict";
import test from "node:test";

import { tetherPath } from "./tether-path.ts";

test("tether routes around a platform instead of through it", () => {
  const path = tetherPath(
    { x: 0, y: 5.6, z: 0 },
    { x: 2.5, y: 2.5, z: 0 },
    [{
      id: "ledge", kind: "staticPlatform", zone: "grass", phase: "armed",
      position: { x: 0, y: 4, z: 0 }, halfExtent: { x: 3, y: 0.5, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
    }],
  );

  assert.deepEqual(path, [
    { x: 0, y: 5.6, z: 0 },
    { x: 3.04, y: 4.54, z: 0 },
    { x: 3.04, y: 3.46, z: 0 },
    { x: 2.5, y: 2.5, z: 0 },
  ]);
});
