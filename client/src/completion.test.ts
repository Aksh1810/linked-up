import assert from "node:assert/strict";
import test from "node:test";

import { formatCompletionTime } from "./completion.ts";

test("completion time formats authoritative ticks as mm:ss", () => {
  assert.equal(formatCompletionTime(60 * 60 * 9 + 60 * 41, 60), "09:41");
});
