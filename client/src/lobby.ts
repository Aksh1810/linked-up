import { LobbyApi, LobbyApiError } from "./lobby-api.ts";
import { LobbyConnection, type PeerMatchLaunch } from "./lobby-connection.ts";
import {
  canSelectMap,
  canStart,
  clearRoomSession,
  loadRoomSession,
  normalizeRoomCode,
  isMapId,
  saveRoomSession,
  type RoomPlayer,
  type RoomSession,
  type RoomState,
} from "./lobby-state.ts";

interface LobbyElements {
  shell: HTMLElement;
  landing: HTMLElement;
  room: HTMLElement;
  playerCount: HTMLSelectElement;
  map: HTMLSelectElement;
  create: HTMLButtonElement;
  code: HTMLOutputElement;
  players: HTMLUListElement;
  copy: HTMLButtonElement;
  start: HTMLButtonElement;
  leave: HTMLButtonElement;
  landingStatus: HTMLElement;
  status: HTMLElement;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing lobby element: ${selector}`);
  return element;
}

function lobbyElements(): LobbyElements {
  return {
    shell: required("#lobby-shell"),
    landing: required("#landing-view"),
    room: required("#room-view"),
    playerCount: required("#player-count"),
    map: required("#room-map"),
    create: required("#create-room"),
    code: required("#room-code"),
    players: required("#room-players"),
    copy: required("#copy-invite"),
    start: required("#start-room"),
    leave: required("#leave-room"),
    landingStatus: required("#landing-status"),
    status: required("#lobby-status"),
  };
}

export function roomSlots(room: RoomState): Array<RoomPlayer | undefined> {
  return Array.from({ length: room.capacity }, (_, index) => room.players[index]);
}

export function friendlyLobbyError(error: unknown): string {
  return error instanceof LobbyApiError
    ? error.message
    : "The room request could not be completed.";
}

export function isCurrentLobbyRoute(version: number, currentVersion: number): boolean {
  return version === currentVersion;
}

export function nextLobbyRouteVersion(version: number): number {
  return version + 1;
}

export function queueLobbyStop(previous: Promise<void>, stop: () => Promise<void>): Promise<void> {
  return previous.then(stop, stop).catch(() => undefined);
}

export function canRunLobbyCommand(busy: boolean): boolean {
  return !busy;
}

export function retireRoomSession(storage: Storage, code: string): RoomSession | undefined {
  const session = loadRoomSession(storage, code);
  clearRoomSession(storage, code);
  return session;
}

export function beginRetiredLeave<T>(
  storage: Storage,
  code: string,
  token: string,
  leave: (token: string) => Promise<T>,
): { session: RoomSession | undefined; request: Promise<T> } {
  const session = retireRoomSession(storage, code);
  return { session, request: leave(token) };
}

export async function startLobby(
  pathname: string,
  onMatch: (launch: PeerMatchLaunch, session: RoomSession) => Promise<void>,
  startupFailure?: string,
): Promise<void> {
  const elements = lobbyElements();
  const app = required<HTMLElement>("#app");
  const api = new LobbyApi();
  let activeConnection: LobbyConnection | undefined;
  let currentRoom: RoomState | undefined;
  let currentSession: RoomSession | undefined;
  let busy = false;
  let handoffStarted = false;
  let routeVersion = 0;
  let stopBarrier = Promise.resolve();

  const isCurrentRoute = (version: number): boolean => isCurrentLobbyRoute(version, routeVersion);
  const advanceRoute = (): number => {
    routeVersion = nextLobbyRouteVersion(routeVersion);
    return routeVersion;
  };

  document.body.classList.add("lobby-active");
  app.hidden = true;
  elements.shell.hidden = false;

  const setStatus = (message: string): void => {
    elements.landingStatus.textContent = message;
    elements.status.textContent = message;
  };

  const setBusy = (value: boolean): void => {
    busy = value;
    elements.create.disabled = value;
    elements.playerCount.disabled = value;
    elements.copy.disabled = value || !currentRoom;
    elements.leave.disabled = value;
    elements.start.disabled = value || !currentRoom || !currentSession
      || !canStart(currentRoom, currentSession.playerId);
    elements.map.disabled = value || !currentRoom || !currentSession
      || !canSelectMap(currentRoom, currentSession.playerId);
  };

  const renderRoom = (room: RoomState): void => {
    currentRoom = room;
    elements.landing.hidden = true;
    elements.room.hidden = false;
    elements.code.value = room.code;
    elements.map.value = room.mapId;
    elements.players.replaceChildren(...roomSlots(room).map((player, index) => {
      const item = document.createElement("li");
      item.className = player ? `room-player room-player--${player.color}` : "room-player room-player--empty";
      if (!player) {
        item.textContent = `Open link ${index + 1}`;
        return item;
      }
      const name = document.createElement("span");
      name.textContent = player.name;
      item.append(name);
      if (player.isHost) {
        const host = document.createElement("span");
        host.className = "host-badge";
        host.textContent = "Host";
        item.append(host);
      }
      return item;
    }));
    const isHost = currentSession !== undefined
      && room.players.some((player) => player.id === currentSession!.playerId && player.isHost);
    const canCurrentPlayerStart = currentSession !== undefined && canStart(room, currentSession.playerId);
    elements.start.hidden = !isHost || room.status !== "waiting";
    elements.start.disabled = busy || !canCurrentPlayerStart;
    setBusy(busy);
    setStatus(room.status === "starting"
      ? "Preparing match..."
      : room.status === "inGame"
        ? "Match launch sent..."
      : "Waiting for your linked crew.");
  };

  const stopConnection = (): Promise<void> => {
    const connection = activeConnection;
    activeConnection = undefined;
    if (connection) stopBarrier = queueLobbyStop(stopBarrier, () => connection.stop());
    return stopBarrier;
  };

  const handoff = async (connection: LobbyConnection, launch: PeerMatchLaunch, version: number): Promise<void> => {
    if (handoffStarted || activeConnection !== connection || !isCurrentRoute(version)) return;
    const session = currentSession;
    if (!session) return;
    handoffStarted = true;
    setBusy(true);
    advanceRoute();
    currentRoom = undefined;
    currentSession = undefined;
    await stopConnection();
    elements.shell.hidden = true;
    document.body.classList.remove("lobby-active");
    await onMatch(launch, session);
  };

  const connect = async (code: string, session: RoomSession, version: number): Promise<void> => {
    await stopBarrier;
    if (!isCurrentRoute(version)) return;
    currentSession = session;
    let connection: LobbyConnection;
    connection = new LobbyConnection(code, session.token, session.playerId, {
      onRoom: (room) => {
        if (activeConnection === connection && isCurrentRoute(version)) renderRoom(room);
      },
      onStatus: (status) => {
        if (activeConnection !== connection || !isCurrentRoute(version)) return;
        if (status === "reconnecting") setStatus("Reconnecting to the room...");
        if (status === "disconnected") setStatus("Could not reconnect to the room.");
      },
      onError: (message) => {
        if (activeConnection === connection && isCurrentRoute(version)) setStatus(message);
      },
      onMatch: (launch) => { void handoff(connection, launch, version); },
    });
    activeConnection = connection;
    await connection.connect();
  };

  const joinAndConnect = async (code: string, version: number): Promise<void> => {
    const response = await api.joinRoom(code);
    if (!isCurrentRoute(version)) {
      void api.leaveRoom(code, response.session.token).catch(() => undefined);
      return;
    }
    saveRoomSession(sessionStorage, code, response.session);
    await connect(code, response.session, version);
  };

  const showRoomError = (code: string, message: string): void => {
    currentRoom = undefined;
    currentSession = undefined;
    elements.landing.hidden = true;
    elements.room.hidden = false;
    elements.code.value = code;
    elements.players.replaceChildren();
    elements.start.hidden = true;
    elements.copy.disabled = true;
    elements.map.disabled = true;
    elements.start.disabled = true;
    elements.leave.disabled = busy;
    setStatus(message);
  };

  const recoverStoredSession = async (code: string, session: RoomSession, version: number): Promise<void> => {
    await stopConnection();
    if (!isCurrentRoute(version)) return;
    let room: RoomState;
    try {
      room = await api.getRoom(code);
    } catch (error) {
      if (!isCurrentRoute(version)) return;
      clearRoomSession(sessionStorage, code);
      showRoomError(code, friendlyLobbyError(error));
      return;
    }
    if (!isCurrentRoute(version)) return;
    if (room.players.some((player) => player.id === session.playerId)) {
      showRoomError(code, "Could not connect to the room.");
      return;
    }

    clearRoomSession(sessionStorage, code);
    if (room.status !== "waiting") {
      showRoomError(code, "This room is already starting.");
      return;
    }
    try {
      await joinAndConnect(code, version);
    } catch (error) {
      if (!isCurrentRoute(version)) return;
      await stopConnection();
      showRoomError(code, friendlyLobbyError(error));
    }
  };

  const openRoom = async (
    code: string,
    version: number,
    session = loadRoomSession(sessionStorage, code),
  ): Promise<void> => {
    setBusy(true);
    showRoomError(code, "Connecting to room...");
    let staleJoinAttempted = false;
    if (session) {
      try {
        await connect(code, session, version);
      } catch {
        if (isCurrentRoute(version) && !staleJoinAttempted) {
          staleJoinAttempted = true;
          await recoverStoredSession(code, session, version);
        }
      } finally {
        if (isCurrentRoute(version)) setBusy(false);
      }
      return;
    }
    try {
      await joinAndConnect(code, version);
    } catch (error) {
      if (!isCurrentRoute(version)) return;
      await stopConnection();
      showRoomError(code, friendlyLobbyError(error));
    } finally {
      if (isCurrentRoute(version)) setBusy(false);
    }
  };

  const showLanding = (): void => {
    currentRoom = undefined;
    currentSession = undefined;
    elements.room.hidden = true;
    elements.landing.hidden = false;
    setStatus("");
    setBusy(false);
  };

  if (startupFailure) {
    showLanding();
    elements.create.disabled = true;
    elements.playerCount.disabled = true;
    setStatus(startupFailure);
    return;
  }

  elements.create.addEventListener("click", async () => {
    if (!canRunLobbyCommand(busy)) return;
    const capacity = Number(elements.playerCount.value);
    if (capacity !== 2 && capacity !== 3 && capacity !== 4) return;
    let version = routeVersion;
    setBusy(true);
    setStatus("Creating room...");
    try {
      const response = await api.createRoom(capacity);
      if (!isCurrentRoute(version)) return;
      const code = response.room.code;
      version = advanceRoute();
      await stopConnection();
      if (!isCurrentRoute(version)) return;
      saveRoomSession(sessionStorage, code, response.session);
      history.pushState({}, "", `/room/${code}`);
      await openRoom(code, version, response.session);
    } catch (error) {
      if (isCurrentRoute(version)) setStatus(friendlyLobbyError(error));
    } finally {
      if (isCurrentRoute(version)) setBusy(false);
    }
  });

  elements.copy.addEventListener("click", async () => {
    if (!canRunLobbyCommand(busy) || !currentRoom) return;
    const version = routeVersion;
    const code = currentRoom.code;
    setBusy(true);
    try {
      await navigator.clipboard.writeText(`${location.origin}/room/${code}`);
      if (isCurrentRoute(version)) setStatus("Invite link copied.");
    } catch {
      if (isCurrentRoute(version)) setStatus("Could not copy the invite link.");
    } finally {
      if (isCurrentRoute(version)) setBusy(false);
    }
  });

  elements.start.addEventListener("click", async () => {
    if (!canRunLobbyCommand(busy) || !currentRoom || !currentSession
      || !canStart(currentRoom, currentSession.playerId)) return;
    const version = routeVersion;
    const code = currentRoom.code;
    const token = currentSession.token;
    setBusy(true);
    try {
      const room = await api.startRoom(code, token);
      if (isCurrentRoute(version)) renderRoom(room);
    } catch (error) {
      if (isCurrentRoute(version)) setStatus(friendlyLobbyError(error));
    } finally {
      if (isCurrentRoute(version)) setBusy(false);
    }
  });

  elements.map.addEventListener("change", async () => {
    if (!canRunLobbyCommand(busy) || !currentRoom || !currentSession
      || !canSelectMap(currentRoom, currentSession.playerId)) {
      if (currentRoom) elements.map.value = currentRoom.mapId;
      return;
    }
    const mapId = elements.map.value;
    if (!isMapId(mapId)) {
      elements.map.value = currentRoom.mapId;
      return;
    }
    const version = routeVersion;
    const room = currentRoom;
    setBusy(true);
    setStatus("Changing map...");
    try {
      const updated = await api.setMap(room.code, currentSession.token, mapId);
      if (isCurrentRoute(version)) renderRoom(updated);
    } catch (error) {
      if (isCurrentRoute(version)) {
        elements.map.value = currentRoom?.mapId ?? room.mapId;
        setStatus(friendlyLobbyError(error));
      }
    } finally {
      if (isCurrentRoute(version)) setBusy(false);
    }
  });

  elements.leave.addEventListener("click", async () => {
    if (!canRunLobbyCommand(busy)) return;
    let version = routeVersion;
    let retiredSession: RoomSession | undefined;
    let retiredCode: string | undefined;
    setBusy(true);
    try {
      if (!currentRoom || !currentSession) {
        version = advanceRoute();
        await stopConnection();
        if (!isCurrentRoute(version)) return;
        history.pushState({}, "", "/");
        showLanding();
        return;
      }
      const code = currentRoom.code;
      const token = currentSession.token;
      retiredCode = code;
      const retiredLeave = beginRetiredLeave(
        sessionStorage,
        code,
        token,
        (leaveToken) => api.leaveRoom(code, leaveToken),
      );
      retiredSession = retiredLeave.session;
      await retiredLeave.request;
      if (!isCurrentRoute(version)) return;
      version = advanceRoute();
      await stopConnection();
      if (!isCurrentRoute(version)) return;
      history.pushState({}, "", "/");
      showLanding();
    } catch (error) {
      if (isCurrentRoute(version)) {
        if (retiredSession && retiredCode && !loadRoomSession(sessionStorage, retiredCode)) {
          saveRoomSession(sessionStorage, retiredCode, retiredSession);
        }
        setStatus(friendlyLobbyError(error));
      }
    } finally {
      if (isCurrentRoute(version)) setBusy(false);
    }
  });

  const renderRoute = async (nextPathname: string): Promise<void> => {
    const version = advanceRoute();
    setBusy(true);
    currentRoom = undefined;
    currentSession = undefined;
    await stopConnection();
    if (!isCurrentRoute(version)) return;
    const match = /^\/room\/([^/]+)\/?$/.exec(nextPathname);
    if (!match) {
      showLanding();
      return;
    }
    await openRoom(normalizeRoomCode(match[1]), version);
  };

  window.addEventListener("pagehide", () => {
    advanceRoute();
    void stopConnection();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void renderRoute(location.pathname);
  });
  window.addEventListener("popstate", () => { void renderRoute(location.pathname); });
  await renderRoute(pathname);
}
