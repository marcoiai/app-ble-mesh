import type { MeshNode } from './node.js';
import { type LevelupMeshSnapshot, type LevelupMeshTransport } from '../levelup-mesh.js';
/** Map a live MeshNode's known peers into a Codex mesh snapshot (with routes). */
export declare function toLevelupSnapshot(node: MeshNode, transport?: LevelupMeshTransport, now?: number): LevelupMeshSnapshot;
//# sourceMappingURL=levelup-bridge.d.ts.map