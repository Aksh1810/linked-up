import assert from "node:assert/strict";
import test from "node:test";

import { countdownLabels, parseMatchLaunch, type MatchLaunch } from "./match-launch.ts";

const playerId = "c7a17aa1-5131-4652-8f9e-e1d5dcb1f66b";
const launch: MatchLaunch = {
  matchId: "8f0b648f-90b2-44d9-a6a7-aac07430c4e4",
  gameplayUrl: "wss://game.test/game",
  countdownSeconds: 3,
  expiresAt: "2099-08-30T12:00:00.000Z",
  playerId,
  color: "blue",
  ticket: "opaque-ticket",
};

test("match launch accepts only the current player and excludes public room fields", () => {
  assert.deepEqual(parseMatchLaunch(launch, playerId), launch);
  assert.throws(() => parseMatchLaunch({ ...launch, ticket: "" }, playerId));
  assert.throws(() => parseMatchLaunch({ ...launch, ticket: " " }, playerId));
  assert.throws(() => parseMatchLaunch({ ...launch, matchId: "8f0b648f-90b2-14d9-a6a7-aac07430c4e4" }, playerId));
  assert.throws(() => parseMatchLaunch({ ...launch, playerId: "6b19b4a6-aab4-4c14-9dbd-7b1aefccec08" }, playerId));
  assert.throws(() => parseMatchLaunch({ ...launch, players: [] }, playerId));
});

test("match launch rejects credentials embedded in the gameplay URL", () => {
  assert.throws(() => parseMatchLaunch({ ...launch, gameplayUrl: "wss://ticket@game.test/game" }, playerId));
  assert.throws(() => parseMatchLaunch({ ...launch, gameplayUrl: "wss://game.test/game?ticket=leak" }, playerId));
  assert.throws(() => parseMatchLaunch({ ...launch, gameplayUrl: "https://game.test/game" }, playerId));
});

test("countdown uses the requested climb sequence", () => {
  assert.deepEqual(countdownLabels(3), ["3", "2", "1", "CLIMB!"]);
});
