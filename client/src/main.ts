import "./styles.css";

import { Game } from "./game";
import type { PlayerId } from "./gameplay-protocol";

const canvas = document.querySelector<HTMLCanvasElement>("#game-canvas");
const loading = document.querySelector<HTMLElement>("#loading");
const status = document.querySelector<HTMLElement>("#status-label");
const playerLabel = document.querySelector<HTMLOutputElement>("#player-label");
const slotPicker = document.querySelector<HTMLElement>("#slot-picker");
const loadingMessage = document.querySelector<HTMLElement>("#loading-message");
const serverCommand = document.querySelector<HTMLElement>("#server-command");
const returnLink = document.querySelector<HTMLAnchorElement>("#return-link");

if (!canvas || !loading || !status || !playerLabel || !slotPicker || !loadingMessage ||
    !serverCommand || !returnLink) {
  throw new Error("Linked-Up shell is incomplete");
}

const requestedPlayer = new URLSearchParams(location.search).get("player");
if (requestedPlayer !== "blue" && requestedPlayer !== "orange") {
  document.body.classList.add("slot-selection");
  slotPicker.hidden = false;
  loading.setAttribute("aria-hidden", "true");
} else {
  const player: PlayerId = requestedPlayer;
  const name = player === "blue" ? "Blue" : "Orange";
  playerLabel.value = name;
  status.textContent = `Connecting as ${name}`;

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
      player,
      gameplayUrl: "ws://127.0.0.1:9002/game",
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
