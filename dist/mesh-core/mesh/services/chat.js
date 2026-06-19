// Chat service — pub/sub rooms over the mesh. Each room is a channel `chat:<room>`.
export function chatService() {
    return {
        name: 'chat',
        attach(node) {
            return {
                on(room, handler) {
                    return node.subscribe(`chat:${room}`, (ctx) => handler(ctx.body));
                },
                say(room, text) {
                    const msg = {
                        room,
                        from: node.id,
                        label: node.info.label,
                        text,
                        ts: Date.now(),
                    };
                    node.publish(`chat:${room}`, 'chat.say', msg);
                },
            };
        },
    };
}
