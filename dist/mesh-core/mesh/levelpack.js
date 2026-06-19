// ── LevelPack experimental domain codec ─────────────────────────────────────
// A tiny binary codec tuned for mesh/game payloads. This is intentionally scoped:
// it aims to beat generic compressors on our small, repetitive protocol objects,
// not on arbitrary files. It is reversible and safe to benchmark before we wire it
// into MeshNode's compression/encryption pipeline.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const TAG_NULL = 0x00;
const TAG_FALSE = 0x01;
const TAG_TRUE = 0x02;
const TAG_INT = 0x03;
const TAG_FLOAT = 0x04;
const TAG_STRING = 0x05;
const TAG_STRING_TOKEN = 0x06;
const TAG_ARRAY = 0x07;
const TAG_OBJECT = 0x08;
const TAG_CHAT = 0x20;
const TAG_GAME_EVENT = 0x21;
const TAG_ENVELOPE = 0x22;
const KEY_TOKENS = [
    'v',
    'id',
    'type',
    'from',
    'to',
    'channel',
    'ttl',
    'path',
    'ts',
    'corr',
    'reply',
    'enc',
    'zip',
    'body',
    'room',
    'label',
    'text',
    'payload',
    'x',
    'y',
    'dx',
    'dy',
    'buttons',
    'seq',
    'tick',
    'state',
    'input',
    'neighbors',
    'caps',
    'hops',
    'lastSeen',
    'direct',
    'host',
    'title',
    'systemId',
];
const STRING_TOKENS = [
    'mesh.hello',
    'mesh.bye',
    'mesh.ping',
    'chat.say',
    'game.lobby',
    'game.join',
    'game.input',
    'game.state',
    'trade.list',
    'trade.req',
    'stream.meta',
    'stream.chunk',
    'chat',
    'game',
    'trade',
    'stream',
    'demo',
    'protocol-demo',
    'radio-demo',
];
const keyToToken = new Map(KEY_TOKENS.map((key, index) => [key, index]));
const stringToToken = new Map(STRING_TOKENS.map((value, index) => [value, index]));
export function levelPack(value) {
    const writer = new BinaryWriter();
    writeValue(writer, normalize(value));
    return writer.finish();
}
export function levelUnpack(bytes) {
    const reader = new BinaryReader(bytes);
    const value = readValue(reader);
    if (!reader.done())
        throw new Error('levelpack: trailing bytes');
    return value;
}
export function levelPackStats(value) {
    const jsonBytes = jsonSize(value);
    const levelPackBytes = levelPack(value).length;
    return {
        jsonBytes,
        levelPackBytes,
        savedBytes: jsonBytes - levelPackBytes,
        ratio: jsonBytes === 0 ? 1 : levelPackBytes / jsonBytes,
    };
}
export function jsonSize(value) {
    return textEncoder.encode(JSON.stringify(value)).length;
}
function normalize(value) {
    if (value == null)
        return null;
    if (typeof value === 'boolean' || typeof value === 'string')
        return value;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (Array.isArray(value))
        return value.map(normalize);
    if (typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (item !== undefined)
                out[key] = normalize(item);
        }
        return out;
    }
    return null;
}
function writeValue(writer, value) {
    if (value === null) {
        writer.u8(TAG_NULL);
        return;
    }
    if (value === false) {
        writer.u8(TAG_FALSE);
        return;
    }
    if (value === true) {
        writer.u8(TAG_TRUE);
        return;
    }
    if (typeof value === 'number') {
        if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
            writer.u8(TAG_INT);
            writer.varint(zigzag(value));
        }
        else {
            writer.u8(TAG_FLOAT);
            writer.f64(value);
        }
        return;
    }
    if (typeof value === 'string') {
        writeValueString(writer, value);
        return;
    }
    if (Array.isArray(value)) {
        writer.u8(TAG_ARRAY);
        writer.varint(value.length);
        value.forEach((item) => writeValue(writer, item));
        return;
    }
    if (writeSpecial(writer, value))
        return;
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    writer.u8(TAG_OBJECT);
    writer.varint(entries.length);
    for (const [key, item] of entries) {
        writeKey(writer, key);
        writeValue(writer, item ?? null);
    }
}
function writeSpecial(writer, value) {
    if (isChat(value)) {
        writer.u8(TAG_CHAT);
        writeRawString(writer, value.room);
        writeRawString(writer, value.from);
        writeRawString(writer, value.label);
        writeRawString(writer, value.text);
        writer.varint(value.ts);
        return true;
    }
    if (isGameEvent(value)) {
        writer.u8(TAG_GAME_EVENT);
        writeRawString(writer, value.from);
        writeValue(writer, value.payload);
        return true;
    }
    if (isEnvelope(value)) {
        writer.u8(TAG_ENVELOPE);
        writer.varint(value.v);
        writeRawString(writer, value.id);
        writeRawString(writer, value.type);
        writeRawString(writer, value.from);
        writeNullableString(writer, value.to);
        writeNullableString(writer, value.channel);
        writer.varint(value.ttl);
        writer.varint(value.path.length);
        value.path.forEach((node) => writeRawString(writer, node));
        writer.varint(value.ts);
        writeNullableString(writer, value.corr);
        writer.u8(value.reply ? 1 : 0);
        writer.u8(value.enc ? 1 : 0);
        writer.u8(value.zip ? 1 : 0);
        writeValue(writer, value.body);
        return true;
    }
    return false;
}
function readValue(reader) {
    const tag = reader.u8();
    if (tag === TAG_NULL)
        return null;
    if (tag === TAG_FALSE)
        return false;
    if (tag === TAG_TRUE)
        return true;
    if (tag === TAG_INT)
        return unzigzag(reader.varint());
    if (tag === TAG_FLOAT)
        return reader.f64();
    if (tag === TAG_STRING)
        return reader.string();
    if (tag === TAG_STRING_TOKEN)
        return STRING_TOKENS[reader.varint()] ?? '';
    if (tag === TAG_ARRAY) {
        const length = reader.varint();
        return Array.from({ length }, () => readValue(reader));
    }
    if (tag === TAG_OBJECT) {
        const length = reader.varint();
        const out = {};
        for (let i = 0; i < length; i += 1)
            out[readKey(reader)] = readValue(reader);
        return out;
    }
    if (tag === TAG_CHAT) {
        return {
            room: reader.string(),
            from: reader.string(),
            label: reader.string(),
            text: reader.string(),
            ts: reader.varint(),
        };
    }
    if (tag === TAG_GAME_EVENT) {
        return {
            from: reader.string(),
            payload: readValue(reader),
        };
    }
    if (tag === TAG_ENVELOPE) {
        const v = reader.varint();
        const id = reader.string();
        const type = reader.string();
        const from = reader.string();
        const to = readNullableString(reader);
        const channel = readNullableString(reader);
        const ttl = reader.varint();
        const pathLength = reader.varint();
        const path = Array.from({ length: pathLength }, () => reader.string());
        const ts = reader.varint();
        const corr = readNullableString(reader);
        const reply = reader.u8() === 1;
        const enc = reader.u8() === 1;
        const zip = reader.u8() === 1;
        const body = readValue(reader);
        const out = { v, id, type, from, to, ttl, path, ts, body };
        if (channel !== null)
            out.channel = channel;
        if (corr !== null)
            out.corr = corr;
        if (reply)
            out.reply = true;
        if (enc)
            out.enc = true;
        if (zip)
            out.zip = true;
        return out;
    }
    throw new Error(`levelpack: unknown tag ${tag}`);
}
function writeValueString(writer, value) {
    const token = stringToToken.get(value);
    if (token !== undefined) {
        writer.u8(TAG_STRING_TOKEN);
        writer.varint(token);
        return;
    }
    writer.u8(TAG_STRING);
    writeRawString(writer, value);
}
function writeRawString(writer, value) {
    const bytes = textEncoder.encode(value);
    writer.varint(bytes.length);
    writer.bytes(bytes);
}
function writeNullableString(writer, value) {
    if (typeof value !== 'string') {
        writer.u8(0);
        return;
    }
    writer.u8(1);
    writeRawString(writer, value);
}
function readNullableString(reader) {
    return reader.u8() === 1 ? reader.string() : null;
}
function writeKey(writer, key) {
    const token = keyToToken.get(key);
    if (token === undefined) {
        writer.u8(0);
        writeRawString(writer, key);
        return;
    }
    writer.u8(1);
    writer.varint(token);
}
function readKey(reader) {
    if (reader.u8() === 1)
        return KEY_TOKENS[reader.varint()] ?? '';
    return reader.string();
}
function isChat(value) {
    return (typeof value.room === 'string' &&
        typeof value.from === 'string' &&
        typeof value.label === 'string' &&
        typeof value.text === 'string' &&
        typeof value.ts === 'number');
}
function isGameEvent(value) {
    return typeof value.from === 'string' && value.payload !== undefined && Object.keys(value).length === 2;
}
function isEnvelope(value) {
    return (typeof value.v === 'number' &&
        typeof value.id === 'string' &&
        typeof value.type === 'string' &&
        typeof value.from === 'string' &&
        (typeof value.to === 'string' || value.to === null) &&
        typeof value.ttl === 'number' &&
        Array.isArray(value.path) &&
        value.path.every((item) => typeof item === 'string') &&
        typeof value.ts === 'number' &&
        value.body !== undefined);
}
function zigzag(value) {
    return value >= 0 ? value * 2 : Math.abs(value) * 2 - 1;
}
function unzigzag(value) {
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}
class BinaryWriter {
    constructor() {
        Object.defineProperty(this, "out", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
    }
    u8(value) {
        this.out.push(value & 0xff);
    }
    bytes(value) {
        value.forEach((byte) => this.u8(byte));
    }
    varint(value) {
        let next = Math.max(0, Math.floor(value));
        while (next >= 0x80) {
            this.u8((next & 0x7f) | 0x80);
            next = Math.floor(next / 128);
        }
        this.u8(next);
    }
    f64(value) {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setFloat64(0, value, true);
        this.bytes(bytes);
    }
    finish() {
        return new Uint8Array(this.out);
    }
}
class BinaryReader {
    constructor(bytes) {
        Object.defineProperty(this, "pos", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "bytes", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.bytes = bytes;
    }
    done() {
        return this.pos === this.bytes.length;
    }
    u8() {
        if (this.pos >= this.bytes.length)
            throw new Error('levelpack: unexpected eof');
        const value = this.bytes[this.pos];
        this.pos += 1;
        return value;
    }
    varint() {
        let value = 0;
        let shift = 0;
        for (;;) {
            const byte = this.u8();
            value += (byte & 0x7f) * 2 ** shift;
            if ((byte & 0x80) === 0)
                return value;
            shift += 7;
            if (shift > 56)
                throw new Error('levelpack: varint too large');
        }
    }
    f64() {
        if (this.pos + 8 > this.bytes.length)
            throw new Error('levelpack: unexpected eof');
        const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8).getFloat64(0, true);
        this.pos += 8;
        return value;
    }
    string() {
        const length = this.varint();
        if (this.pos + length > this.bytes.length)
            throw new Error('levelpack: unexpected eof');
        const value = textDecoder.decode(this.bytes.slice(this.pos, this.pos + length));
        this.pos += length;
        return value;
    }
}
