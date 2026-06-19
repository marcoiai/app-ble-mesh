// Stream service — chunked pub/sub broadcast over the mesh. A publisher opens a
// stream (channel `stream:<id>`) and pushes chunks; listeners subscribe and relay
// onward automatically (point→point→point), so a viewer two hops away still gets
// the feed with no central HLS host. Chunks are opaque (base64 audio/video/data) —
// wiring them into a <video> via MediaSource is the renderer's job.
const REANNOUNCE_MS = 2500;
export function streamService() {
    return {
        name: 'stream',
        attach(node) {
            return {
                open(metaIn) {
                    const meta = { ...metaIn, host: node.id };
                    node.broadcast('stream.live', meta); // announce to the mesh
                    // Keep re-announcing so listeners can tell live streams from stale ones.
                    const reannounce = setInterval(() => node.broadcast('stream.live', meta), REANNOUNCE_MS);
                    let seq = 0;
                    return {
                        push: (data) => node.publish(`stream:${meta.id}`, 'stream.chunk', {
                            id: meta.id,
                            seq: seq++,
                            data,
                        }),
                        close: () => {
                            clearInterval(reannounce);
                            node.publish(`stream:${meta.id}`, 'stream.end', { id: meta.id });
                            node.broadcast('stream.dead', { id: meta.id }); // tell the list to drop it now
                        },
                    };
                },
                listen(id, { onChunk, onEnd }) {
                    return node.subscribe(`stream:${id}`, (ctx) => {
                        if (ctx.type === 'stream.chunk')
                            onChunk?.(ctx.body);
                        else if (ctx.type === 'stream.end')
                            onEnd?.();
                    });
                },
                onAnnounce(handler) {
                    return node.on('stream.live', (ctx) => handler(ctx.body));
                },
                onGone(handler) {
                    return node.on('stream.dead', (ctx) => handler(ctx.body.id));
                },
            };
        },
    };
}
