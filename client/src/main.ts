import "./styles.css";

import { Game } from "./game";
import type { GameplayConnectionIdentity } from "./gameplay-connection";
import type { PlayerId } from "./gameplay-protocol";
import { startLobby } from "./lobby.ts";
import { countdownLabels, type MatchLaunch } from "./match-launch.ts";

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function showMatchCountdown(launch: MatchLaunch): Promise<void> {
  const app = document.querySelector<HTMLElement>("#app");
  const loading = document.querySelector<HTMLElement>("#loading");
  const loadingMessage = document.querySelector<HTMLElement>("#loading-message");
  const serverCommand = document.querySelector<HTMLElement>("#server-command");
  const returnLink = document.querySelector<HTMLAnchorElement>("#return-link");
  if (!app || !loading || !loadingMessage || !serverCommand || !returnLink) {
    throw new Error("Linked-Up shell is incomplete");
  }

  app.hidden = false;
  loading.classList.remove("error");
  loading.setAttribute("aria-hidden", "false");
  serverCommand.hidden = true;
  returnLink.hidden = true;
  for (const label of countdownLabels(launch.countdownSeconds)) {
    loadingMessage.textContent = label;
    await pause(1_000);
  }
  loadingMessage.textContent = "Preparing secure connection…";
}

async function startGame(gameplayUrl: string, identity: GameplayConnectionIdentity): Promise<void> {
  const app = document.querySelector<HTMLElement>("#app");
  const canvas = document.querySelector<HTMLCanvasElement>("#game-canvas");
  const loading = document.querySelector<HTMLElement>("#loading");
  const status = document.querySelector<HTMLElement>("#status-label");
  const playerLabel = document.querySelector<HTMLOutputElement>("#player-label");
  const slotPicker = document.querySelector<HTMLElement>("#slot-picker");
  const loadingMessage = document.querySelector<HTMLElement>("#loading-message");
  const serverCommand = document.querySelector<HTMLElement>("#server-command");
  const returnLink = document.querySelector<HTMLAnchorElement>("#return-link");

  if (!app || !canvas || !loading || !status || !playerLabel || !slotPicker || !loadingMessage ||
      !serverCommand || !returnLink) throw new Error("Linked-Up shell is incomplete");

  app.hidden = false;
  playerLabel.value = "Match robot";
  status.textContent = "Connecting to gameplay server";

  const showError = (message: string): void => {
    status.textContent = message;
    loading.classList.add("error");
    loadingMessage.textContent = message;
    serverCommand.hidden = message !== "Could not connect to the gameplay server.";
    returnLink.hidden = false;
    loading.setAttribute("aria-hidden", "false");
  };

  try {
    const game = await Game.create(canvas, {
      gameplayUrl,
      identity,
      onReady: () => {
        loading.setAttribute("aria-hidden", "true");
        document.body.classList.add("ready");
        canvas.focus();
      },
      onStatus: (message) => { status.textContent = message; },
      onError: showError,
    });
    window.addEventListener("beforeunload", () => game.dispose(), { once: true });
  } catch (error) {
    console.error("Could not start Linked-Up", error);
    showError("Could not start the 3D scene.");
  }
}

const requestedPlayer = new URLSearchParams(location.search).get("player");
if (requestedPlayer === "blue" || requestedPlayer === "orange") {
  await startGame("ws://127.0.0.1:9002/game", { player: requestedPlayer });
} else {
  await startLobby(location.pathname, async (launch) => {
    await showMatchCountdown(launch);
    await startGame(launch.gameplayUrl, { matchId: launch.matchId, ticket: launch.ticket });
  });
}
