// Game service — lobby + state/input sync over a channel `game:<id>`. Minimal
// building block for nearby multiplayer: a host announces a lobby, peers join,
// inputs and state snapshots are published to everyone in the lobby. Netcode
// (rollback, lockstep, authority) is left to the game on top — this is transport.
export function gameService() {
    return {
        name: 'game',
        attach(node) {
            return {
                host(lobbyIn) {
                    const lobby = { ...lobbyIn, host: node.id };
                    node.broadcast('game.lobby', lobby);
                    node.publish(`game:${lobby.id}`, 'game.join', { from: node.id });
                },
                join(id) {
                    node.publish(`game:${id}`, 'game.join', { from: node.id });
                },
                input(id, payload) {
                    node.publish(`game:${id}`, 'game.input', { from: node.id, payload });
                },
                state(id, payload) {
                    node.publish(`game:${id}`, 'game.state', { from: node.id, payload });
                },
                onInput(id, handler) {
                    return node.subscribe(`game:${id}`, (ctx) => {
                        if (ctx.type !== 'game.input')
                            return;
                        const { from, payload } = ctx.body;
                        handler(from, payload);
                    });
                },
                onState(id, handler) {
                    return node.subscribe(`game:${id}`, (ctx) => {
                        if (ctx.type !== 'game.state')
                            return;
                        const { from, payload } = ctx.body;
                        handler(from, payload);
                    });
                },
                onLobby(handler) {
                    return node.on('game.lobby', (ctx) => handler(ctx.body));
                },
            };
        },
    };
}
