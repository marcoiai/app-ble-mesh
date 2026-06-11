import { useEffect, useState } from "react";
import { compressionSupported, gzipValue, jsonSize, levelPack, levelUnpack } from "./mesh-core";

type BenchRow = {
  name: string;
  json: number;
  gzip: number | null;
  levelpack: number;
  winner: "json" | "gzip" | "levelpack";
  roundTrip: boolean;
};

const samples: Array<{ name: string; value: unknown }> = [
  {
    name: "chat.say curto",
    value: {
      room: "radio-demo",
      from: "node-a7f19c",
      label: "Android radio",
      text: "bora jogar",
      ts: 1791724188123,
    },
  },
  {
    name: "game.input",
    value: {
      from: "node-a7f19c",
      payload: {
        seq: 118,
        tick: 2294,
        dx: 1,
        dy: 0,
        buttons: 5,
      },
    },
  },
  {
    name: "game.state delta",
    value: {
      from: "node-host",
      payload: {
        tick: 2294,
        state: [
          { id: "p1", x: 412, y: 188, dx: 1, dy: 0 },
          { id: "p2", x: 220, y: 191, dx: -1, dy: 0 },
          { id: "coin-7", x: 310, y: 90 },
        ],
      },
    },
  },
  {
    name: "mesh envelope chat",
    value: {
      v: 1,
      id: "018fc8b2-2b93-7727-bad1-2a94f0da7001",
      type: "chat.say",
      from: "node-a7f19c",
      to: null,
      channel: "chat:radio-demo",
      ttl: 6,
      path: ["node-a7f19c", "node-relay"],
      ts: 1791724188123,
      body: {
        room: "radio-demo",
        from: "node-a7f19c",
        label: "Android radio",
        text: "offgrid funcionando",
        ts: 1791724188123,
      },
    },
  },
  {
    name: "mesh hello",
    value: {
      v: 1,
      id: "018fc8b2-2b93-7727-bad1-2a94f0da7002",
      type: "mesh.hello",
      from: "node-mac",
      to: null,
      ttl: 4,
      path: ["node-mac"],
      ts: 1791724188123,
      body: {
        id: "node-mac",
        label: "Desktop radio",
        caps: ["ble", "chat", "ping"],
        neighbors: ["node-android"],
      },
    },
  },
];

export function LevelPackBench() {
  const [rows, setRows] = useState<BenchRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    void runBench().then((next) => {
      if (!cancelled) setRows(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section style={panel}>
      <div style={header}>
        <div>
          <h2 style={title}>LevelPack Lab</h2>
          <p style={subtitle}>Domain codec vs JSON and gzip on mesh-sized payloads.</p>
        </div>
        <span style={pill}>{compressionSupported() ? "gzip available" : "gzip unavailable"}</span>
      </div>

      <div style={table}>
        <div style={head}>Payload</div>
        <div style={head}>JSON</div>
        <div style={head}>gzip</div>
        <div style={head}>LevelPack</div>
        <div style={head}>Winner</div>
        {rows.map((row) => (
          <Row key={row.name} row={row} />
        ))}
      </div>
    </section>
  );
}

function Row({ row }: { row: BenchRow }) {
  return (
    <>
      <div style={cell}>{row.name}</div>
      <div style={cell}>{row.json} B</div>
      <div style={cell}>{row.gzip == null ? "-" : `${row.gzip} B`}</div>
      <div style={cell}>
        <strong>{row.levelpack} B</strong>
      </div>
      <div style={cell}>
        <span style={winner(row.winner === "levelpack")}>
          {row.winner}
          {row.roundTrip ? "" : " / bad roundtrip"}
        </span>
      </div>
    </>
  );
}

async function runBench(): Promise<BenchRow[]> {
  const hasGzip = compressionSupported();
  const rows: BenchRow[] = [];
  for (const sample of samples) {
    const packed = levelPack(sample.value);
    const unpacked = levelUnpack(packed);
    const gzip = hasGzip ? byteLength(await gzipValue(sample.value)) : null;
    const json = jsonSize(sample.value);
    const sizes = [
      { name: "json" as const, size: json },
      { name: "levelpack" as const, size: packed.length },
      ...(gzip == null ? [] : [{ name: "gzip" as const, size: gzip }]),
    ];
    sizes.sort((a, b) => a.size - b.size);
    rows.push({
      name: sample.name,
      json,
      gzip,
      levelpack: packed.length,
      winner: sizes[0].name,
      roundTrip: sameValue(unpacked, sample.value),
    });
  }
  return rows;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aEntries = Object.entries(a).filter(([, value]) => value !== undefined);
    const bEntries = Object.entries(b).filter(([, value]) => value !== undefined);
    if (aEntries.length !== bEntries.length) return false;
    return aEntries.every(([key, value]) => sameValue(value, (b as Record<string, unknown>)[key]));
  }
  return false;
}

function byteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

const panel: React.CSSProperties = {
  border: "1px solid #d9dde3",
  borderRadius: 8,
  padding: 16,
  marginBottom: 22,
  background: "#ffffff",
};

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "flex-start",
};

const title: React.CSSProperties = {
  margin: 0,
  textAlign: "left",
};

const subtitle: React.CSSProperties = {
  margin: "4px 0 0",
  color: "#596677",
  fontSize: 13,
};

const pill: React.CSSProperties = {
  padding: "3px 8px",
  borderRadius: 999,
  color: "#0f5132",
  background: "#d1e7dd",
  fontSize: 12,
  fontWeight: 700,
};

const table: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(150px, 1.4fr) repeat(4, minmax(72px, 0.7fr))",
  gap: 1,
  marginTop: 14,
  overflowX: "auto",
};

const head: React.CSSProperties = {
  padding: "7px 8px",
  background: "#eef2f6",
  color: "#334155",
  fontSize: 12,
  fontWeight: 700,
};

const cell: React.CSSProperties = {
  padding: "7px 8px",
  background: "#fbfcfd",
  color: "#27313f",
  fontSize: 12,
};

const winner = (active: boolean): React.CSSProperties => ({
  display: "inline-block",
  padding: "2px 6px",
  borderRadius: 999,
  color: active ? "#0f5132" : "#664d03",
  background: active ? "#d1e7dd" : "#fff3cd",
  fontWeight: 700,
});
