// Trade service — request/reply object exchange. A node "offers" objects locally;
// peers can list a node's catalog and fetch a specific object across the mesh.
// "Objects" are anything: ROM blobs, save states, items, cards. Binary rides as
// base64 in `data` for the JSON MVP codec.
export function tradeService() {
    const store = new Map();
    return {
        name: 'trade',
        attach(node) {
            const listing = () => [...store.values()].map(({ data: _data, ...rest }) => rest);
            // Answer catalog + object requests from peers.
            node.on('trade.list', (ctx) => ctx.reply(listing()));
            node.on('trade.get', (ctx) => {
                const { id } = ctx.body ?? { id: '' };
                ctx.reply(store.get(id) ?? null);
            });
            return {
                offer: (obj) => void store.set(obj.id, obj),
                withdraw: (id) => void store.delete(id),
                catalog: listing,
                list: (peer) => node.request(peer, 'trade.list', {}),
                fetch: (peer, id) => node.request(peer, 'trade.get', { id }),
            };
        },
    };
}
