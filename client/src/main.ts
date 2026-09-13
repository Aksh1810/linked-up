import "./styles.css";

import { Game } from "./game";
import { GameplayConnection, type GameplayTransport } from "./gameplay-connection";
import { startLobby } from "./lobby.ts";
import { MatchOrchestrator } from "./match-orchestrator.ts";
import { countdownLabels } from "./match-launch.ts";
import { peerFailureMessage } from "./peer-status.ts";
import { nativeDevelopmentPlayer, peerRuntimeSupport } from "./runtime-mode.ts";

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function showMatchCountdown(launch: { countdownSeconds: 3 }): Promise<void> {
  const app = document.querySelector<HTMLElement>("#app");
  const loading = document.querySelector<HTMLElement>("#loading");
  const loadingMessage = document.querySelector<HTMLElement>("#loading-message");
  const serverCommand = document.querySelector<HTMLElement>("#server-command");
  const returnLink = document.querySelector<HTMLAnchorElement>("#return-link");
  const retryLink = document.querySelector<HTMLAnchorElement>("#retry-link");
  if (!app || !loading || !loadingMessage || !serverCommand || !returnLink || !retryLink) {
    throw new Error("Linked-Up shell is incomplete");
  }

  app.hidden = false;
  loading.classList.remove("error");
  loading.setAttribute("aria-hidden", "false");
  serverCommand.hidden = true;
  returnLink.hidden = true;
  retryLink.hidden = true;
  for (const label of countdownLabels(launch.countdownSeconds)) {
    loadingMessage.textContent = label;
    await pause(1_000);
  }
  loadingMessage.textContent = "Preparing secure connection…";
}

function showPeerOverlay(message: string, error: boolean): void {
  const app = document.querySelector<HTMLElement>("#app");
  const loading = document.querySelector<HTMLElement>("#loading");
  const loadingMessage = document.querySelector<HTMLElement>("#loading-message");
  const retryLink = document.querySelector<HTMLAnchorElement>("#retry-link");
  const returnLink = document.querySelector<HTMLAnchorElement>("#return-link");
  if (!app || !loading || !loadingMessage || !retryLink || !returnLink) return;
  app.hidden = false;
  loading.classList.toggle("error", error);
  loading.setAttribute("aria-hidden", "false");
  loadingMessage.textContent = message;
  retryLink.href = location.href;
  retryLink.hidden = !error;
  returnLink.hidden = !error;
}

async function startGame(transport: GameplayTransport, peerHosted = false): Promise<void> {
  const app = document.querySelector<HTMLElement>("#app");
  const canvas = document.querySelector<HTMLCanvasElement>("#game-canvas");
  const loading = document.querySelector<HTMLElement>("#loading");
  const status = document.querySelector<HTMLElement>("#status-label");
  const playerLabel = document.querySelector<HTMLOutputElement>("#player-label");
  const slotPicker = document.querySelector<HTMLElement>("#slot-picker");
  const loadingMessage = document.querySelector<HTMLElement>("#loading-message");
  const serverCommand = document.querySelector<HTMLElement>("#server-command");
  const returnLink = document.querySelector<HTMLAnchorElement>("#return-link");
  const retryLink = document.querySelector<HTMLAnchorElement>("#retry-link");

  if (!app || !canvas || !loading || !status || !playerLabel || !slotPicker || !loadingMessage ||
      !serverCommand || !returnLink || !retryLink) throw new Error("Linked-Up shell is incomplete");

  app.hidden = false;
  playerLabel.value = "Match robot";
  status.textContent = "Connecting to match";

  const showError = (message: string): void => {
    status.textContent = message;
    loading.classList.add("error");
    loadingMessage.textContent = message;
    serverCommand.hidden = message !== "Could not connect to the gameplay server.";
    retryLink.href = location.href;
    retryLink.hidden = !peerHosted;
    returnLink.hidden = false;
    loading.setAttribute("aria-hidden", "false");
  };

  try {
    const game = await Game.create(canvas, {
      transport,
      onReady: () => {
        loading.setAttribute("aria-hidden", "true");
        document.body.classList.add("ready");
        canvas.focus();
      },
      onStatus: (message) => { status.textContent = message; },
      onError: (message) => showError(peerHosted ? peerFailureMessage(message) : message),
    });
    window.addEventListener("beforeunload", () => game.dispose(), { once: true });
  } catch (error) {
    console.error("Could not start Linked-Up", error);
    const reason = error instanceof Error ? error.message : error;
    showError(peerHosted ? peerFailureMessage(reason) : "Could not start the 3D scene.");
  }
}

const requestedPlayer = nativeDevelopmentPlayer(location.search, import.meta.env as unknown as Record<string, unknown>);
if (import.meta.env.DEV && requestedPlayer) {
  await startGame(new GameplayConnection("ws://127.0.0.1:9002/game", { player: requestedPlayer }));
} else {
  const runtimeFailure = peerRuntimeSupport(globalThis as unknown as Record<string, unknown>);
  await startLobby(location.pathname, async (launch, session) => {
    showPeerOverlay(launch.role === "host"
      ? "Waiting for every player to connect. Keep this tab open."
      : "Connecting directly to the room host…", false);
    try {
      const transport = await MatchOrchestrator.start(launch, session);
      await showMatchCountdown(launch);
      if (launch.role === "host") {
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) return;
          const status = document.querySelector<HTMLElement>("#status-label");
          if (status) status.textContent = "Host tab is hidden; the match may pause for everyone.";
        });
      }
      await startGame(transport, true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : error;
      showPeerOverlay(peerFailureMessage(reason), true);
    }
  }, runtimeFailure);
}
