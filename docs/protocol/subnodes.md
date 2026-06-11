# subNodes

`subNode` is the protocol name for what we were informally calling an "island".

A subNode is not a separate network and not a wall. It is a local optimization
context inside the larger mesh: a group of nearby nodes that currently share enough
state to speak more compactly.

The global mesh remains the routing domain. subNodes are temporary contexts within it.

## Why subNodes exist

subNodes let nearby peers reduce bytes, discovery noise, and repeated metadata while
still allowing messages to travel through the wider mesh.

They can share:

- codec version and mode
- dictionary hash
- short peer handles
- service summaries
- delta caches by channel or room
- group key metadata, without exposing the key
- topology summaries
- epoch number for context changes

## Modes

Frames should not require subNode context for basic routing. Context is only required
for optimized payload decoding.

Common mode:

- universal, minimally encoded
- used for hello, discovery, invites, dictionary sync, and fallback
- understood across subNodes

subNode mode:

- compact, context-aware
- can use short handles, dictionaries, deltas, bit packing, and LevelPack layouts
- only peers with the same subNode context decode it directly

Bridge mode:

- used by nodes that can see more than one subNode
- forwards opaque encrypted payloads when it cannot decode them
- can re-pack clear or permitted payloads from one subNode context to another

## Discovery Across subNodes

Long-range lookup should be layered instead of flooding the whole mesh first.

1. Query the local subNode.
2. Ask bridge peers if the target is unknown locally.
3. Bridges forward a compact common-mode query to adjacent subNodes.
4. Replies return over the learned path or reverse breadcrumbs.
5. Emergency or urgent traffic can fall back to controlled flooding.

Example common-mode query:

```txt
DISCOVER {
  target: hash(peerId | serviceId | name)
  scope: mesh | nearby | trusted
  ttl: 6
  queryId: short-random
  returnPath: breadcrumbs
}
```

Inside one subNode, the same intent can be compressed with local handles:

```txt
q=17, t=hash, ttl=6
```

## Cost Model

Flooding cost is roughly proportional to every reachable link in the mesh.

subNode discovery cost is closer to:

```txt
local subNode cost + visited bridge cost + destination subNode cost
```

For example, in a 1000-node mesh split into 20 subNodes of roughly 50 nodes,
a lookup can often touch tens or low hundreds of receivers instead of all 1000.

Concrete example:

```txt
nodes:         1000
subNodes:      20
nodes/subNode: 50
bridge fanout: 2-4 neighboring subNodes per search layer
```

Naive flood:

```txt
query receivers ~= 1000
```

subNode lookup, target found one cluster away:

```txt
local subNode:        ~50 receivers
bridge summaries:    ~2-4 bridge transmissions
destination subNode:  ~50 receivers
total:               ~102-108 receivers/transmissions plus bridge overhead
```

subNode lookup, target found after three bridge layers:

```txt
local subNode:        ~50
visited bridges:      ~8-24 summary transmissions
candidate subNodes:   ~2-4 * 50 if the search fans out
typical total:        ~160-280
```

Worst case:

```txt
target unknown, ttl reaches the whole mesh
cost can approach flooding
```

The win is not that subNodes make discovery free. The win is that the common case
does not start by waking every node. The protocol spends cheap summary packets
first, and only escalates toward broader flooding when the lookup really needs it.

This should be adaptive:

```txt
cheap path:
  local subNode -> bridge summaries -> destination subNode

urgent path:
  local subNode -> controlled flood with TTL and dedup

emergency path:
  wider flood, still bounded by TTL and seen-query cache
```

The rough order of cost becomes:

```txt
local lookup:       O(nodes in one subNode)
bridged lookup:     O(local subNode + bridge fanout * depth + destination subNode)
full flood fallback: O(reachable mesh)
```

## Comparison With Other Strategies

Pure flooding:

```txt
how it works:
  every node repeats the query until TTL expires

cost:
  high; can approach every reachable node/link

strength:
  simple, robust, good emergency fallback

weakness:
  noisy, battery-heavy, repeats work, scales poorly
```

Gossip fanout:

```txt
how it works:
  each node forwards to a small random subset of neighbors

cost:
  medium; lower than flood, probabilistic coverage

strength:
  cheap and resilient when exact routing is unknown

weakness:
  no guarantee the query reaches the right region quickly
```

Route-table lookup:

```txt
how it works:
  nodes maintain routes to known peers/services

cost:
  low when routes are fresh

strength:
  fast directed delivery

weakness:
  stale routes are common in mobile/off-grid mesh
```

DHT-like lookup:

```txt
how it works:
  keyspace maps target hashes to responsible nodes

cost:
  low to medium in stable networks

strength:
  elegant for large stable overlays

weakness:
  too brittle for short-lived BLE/Wi-Fi proximity islands unless heavily adapted
```

subNode discovery:

```txt
how it works:
  search local context first, then bridge compact summaries between contexts

cost:
  low to medium in the common case; flood-like in worst-case fallback

strength:
  keeps routing global but optimizes discovery, dictionaries, handles, and deltas locally

weakness:
  more protocol machinery: epochs, summaries, bridge logic, expiry, merge/split
```

Short version:

```txt
flooding      = best emergency hammer
gossip        = cheap probabilistic spread
route table   = best when topology is known
DHT           = best for stable large overlays
subNode       = best fit for mobile/off-grid mesh with local density and moving bridges
```

The tradeoffs are:

- memory for dictionaries, epochs, summaries, and delta caches
- CPU for bridge decisions and possible re-packing
- a few extra bytes for query id, TTL, scope, and return path
- possible latency from staged discovery
- more protocol complexity around expiry, dedup, merge, and split

## Naming

Use `subNode` in code and docs.

Avoid `island` except when discussing the old mental model. The important distinction:

```txt
island  = sounds isolated
subNode = a local context inside the larger mesh
```
