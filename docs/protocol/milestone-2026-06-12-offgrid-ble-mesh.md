# Milestone: off-grid BLE mesh, multi-device smoke test

Date: 2026-06-12
Branch baseline: `dev` at `e89f9fd`

## What worked

- Android acted as the BLE bridge/peripheral.
- M1 and M5 connected to the Droid at the same time.
- The devices eventually saw each other in `Nearby Mesh`.
- Ping worked across the off-grid BLE mesh.
- The test ran without Wi-Fi as the required transport.

## Important caveat

The M5 stayed isolated for a long time before joining the visible mesh. It only started working after a disconnect/reconnect cycle during manual testing.

This means the milestone is real, but not yet stable enough to call production-ready. The next work must focus on link health and multi-link convergence.

## Current patch behavior

- Android notification queue was increased so larger mesh-core frames are not truncated.
- macOS removes a BLE link when the notification stream ends, avoiding zombie connections.
- Android can list subscribed Macs as connected links.

## Stability tests needed

1. Start Droid first, then M1, then M5.
2. Start M1 first, then Droid, then M5.
3. Start both Macs first, then Droid.
4. Keep all three connected for at least 10 minutes.
5. Send ping M1 -> Droid, M5 -> Droid, Droid -> M1, Droid -> M5.
6. Send chat both directions between each Mac and the Droid.
7. Disconnect one Mac and confirm the other keeps working.
8. Reconnect the disconnected Mac and confirm it rejoins without isolating the first Mac.
9. Turn Bluetooth off/on on one Mac and confirm the mesh recovers.
10. Repeat fully off-grid.

## Protocol follow-up

Move dead-link handling from UI/native state into a protocol-level Link Manager:

- adapters emit raw `link_up`, `link_down`, `rx`, `tx_error`;
- Link Manager tracks `alive`, `suspect`, `dead`, `reconnecting`;
- mesh router chooses routes based on healthy links;
- app-level ping/chat should not care which radio carried the packet.
