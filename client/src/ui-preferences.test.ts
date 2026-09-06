import assert from "node:assert/strict";
import test from "node:test";

import { cameraSettings, readUiPreferences } from "./ui-preferences.ts";

test("camera preferences use safe defaults and reject malformed storage", () => {
  assert.deepEqual(readUiPreferences({ getItem: () => null }), {
    cameraSensitivity: "medium", invertY: false,
  });
  assert.deepEqual(readUiPreferences({ getItem: () => "broken" }), {
    cameraSensitivity: "medium", invertY: false,
  });
});

test("camera settings honor sensitivity, inversion, and reduced motion", () => {
  assert.deepEqual(cameraSettings({ cameraSensitivity: "high", invertY: true }, true, 1 / 60), {
    angularSensibilityX: 650,
    angularSensibilityY: -650,
    inertia: 0,
    targetBlend: 1,
  });
  const standard = cameraSettings({ cameraSensitivity: "low", invertY: false }, false, 1 / 60);
  assert.equal(standard.angularSensibilityX, 1600);
  assert.equal(standard.angularSensibilityY, 1600);
  assert.equal(standard.inertia, 0.82);
  assert.ok(standard.targetBlend > 0 && standard.targetBlend < 1);
});
