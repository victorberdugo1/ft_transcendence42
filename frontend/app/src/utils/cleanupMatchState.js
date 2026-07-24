export function cleanupMatchState() {
  try {
    if (window._ws?.readyState === 1) {
      window._ws.send(JSON.stringify({ type: "leave" }));
    }
  } catch (_) { }

  if (window._eliminatedFromSession) {
    try {
      const existing = parseInt(
        sessionStorage.getItem("matchmakingSafeAt") ?? "0",
        10,
      );
      const proposed = Date.now() + 9000;
      if (proposed > existing)
        sessionStorage.setItem("matchmakingSafeAt", String(proposed));
    } catch (_) { }
  }

  Object.assign(window, {
    _isSpectator: false,
    _spectatorMode: null,
    _matchSession: null,
    _victoryActive: false,
    _victoryConsumed: true,
    _hitstopState: null,
    _countdownStart: null,
    _countdownEndsAt: null,
    _countdownDurationMs: 0,
    _countdownDone: false,
    _confirmedStageId: undefined,
    _isHost: undefined,
    _charSelectData: null,
    _charSelectConfirmed: false,
    _gameState: { players: {} },
    _eliminatedFromSession: null,
    _pendingTournament: false,
    _pendingTraining: null,
  });

  try {
    [
      "charSelectData",
      "pendingCharSelect",
      "watchSession",
      "gameState",
      "confirmedStageId",
    ].forEach((k) => sessionStorage.removeItem(k));
  } catch (_) { }
}
