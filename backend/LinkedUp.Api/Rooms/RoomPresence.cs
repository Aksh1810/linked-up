using System.Collections.Concurrent;

namespace LinkedUp.Api.Rooms;

public sealed class RoomPresence
{
    private readonly ConcurrentDictionary<string, (string RoomCode, Guid PlayerId)> _connections = [];
    // ponytail: global presence gate; shard by room if subscription throughput matters.
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<T> AddAsync<T>(
        string connectionId,
        Func<Task<(string RoomCode, Guid PlayerId, T Result)>> resolve,
        Func<string, Task> addToGroup,
        CancellationToken token = default)
    {
        await _gate.WaitAsync(token);
        try
        {
            var resolved = await resolve();
            var membership = (resolved.RoomCode, resolved.PlayerId);
            if (_connections.TryGetValue(connectionId, out var existing))
            {
                if (existing != membership)
                {
                    throw new InvalidOperationException(
                        "A connection cannot subscribe to a different room or player.");
                }

                return resolved.Result;
            }

            await addToGroup(resolved.RoomCode);
            _connections[connectionId] = membership;
            return resolved.Result;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<(bool IsLast, T? Result)> RemoveAsync<T>(
        string connectionId,
        Func<string, Guid, Task<T>> removeLast,
        CancellationToken token = default)
    {
        await _gate.WaitAsync(token);
        try
        {
            if (!_connections.TryRemove(connectionId, out var membership))
            {
                return (false, default);
            }

            if (!_connections.Values.Any(current => current == membership))
            {
                return (true, await removeLast(membership.RoomCode, membership.PlayerId));
            }

            return (false, default);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> AllPlayersConnected(
        string roomCode, IReadOnlyCollection<Guid> playerIds, CancellationToken token = default)
    {
        await _gate.WaitAsync(token);
        try
        {
            var connected = _connections.Values
                .Where(connection => connection.RoomCode == roomCode)
                .Select(connection => connection.PlayerId)
                .ToHashSet();
            return playerIds.All(connected.Contains);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<IReadOnlyCollection<string>> ConnectionIds(
        string roomCode, Guid playerId, CancellationToken token = default)
    {
        await _gate.WaitAsync(token);
        try
        {
            return _connections
                .Where(connection => connection.Value == (roomCode, playerId))
                .Select(connection => connection.Key)
                .ToArray();
        }
        finally
        {
            _gate.Release();
        }
    }
}
