import assert from "node:assert/strict";
import test from "node:test";

import { isNativeDevelopmentMode, nativeDevelopmentPlayer, peerRuntimeSupport } from "./runtime-mode.ts";

test("native player bypass is available only in an explicit development build", () => {
  assert.equal(isNativeDevelopmentMode({ DEV: true }), true);
  assert.equal(isNativeDevelopmentMode({ DEV: false }), false);
  assert.equal(isNativeDevelopmentMode({ DEV: "true" }), false);
  assert.equal(nativeDevelopmentPlayer("?player=blue", { DEV: true }), "blue");
  assert.equal(nativeDevelopmentPlayer("?player=orange", { DEV: false }), undefined);
  assert.equal(nativeDevelopmentPlayer("?player=purple", { DEV: true }), undefined);
});

test("peer runtime support reports a stable browser capability failure", () => {
  assert.equal(peerRuntimeSupport({ WebAssembly: {}, Worker: {}, RTCPeerConnection: {} }), undefined);
  assert.equal(peerRuntimeSupport({ WebAssembly: {}, Worker: {} }), "This browser cannot create a direct multiplayer connection.");
  assert.equal(peerRuntimeSupport({ Worker: {}, RTCPeerConnection: {} }), "This browser cannot run the match simulation.");
});
