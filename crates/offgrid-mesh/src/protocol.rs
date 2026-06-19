use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

const MAGIC: [u8; 4] = *b"PULS";
const FRAGMENT_MAGIC: [u8; 4] = *b"PFRG";
const VERSION: u8 = 1;
const HEADER_LEN: usize = 20;
const FRAGMENT_HEADER_LEN: usize = 14;

pub const BROADCAST_ADDR: u16 = 0xffff;
pub const OPCODE_TEXT: u16 = 1;
pub const OPCODE_PING: u16 = 2;
pub const OPCODE_PONG: u16 = 3;
pub const OPCODE_CORE_FRAME: u16 = 16;
pub const DEFAULT_BLE_PACKET_LEN: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolFrame {
    pub src_addr: u16,
    pub dst_addr: u16,
    pub ttl: u8,
    pub sequence_number: u32,
    pub opcode: u16,
    pub payload: Vec<u8>,
    pub checksum: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolFrameOut {
    pub src_addr: u16,
    pub dst_addr: u16,
    pub ttl: u8,
    pub sequence_number: u32,
    pub opcode: u16,
    pub payload_text: String,
    pub payload_len: usize,
    pub checksum: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolNodeInfo {
    pub node_addr: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FrameKey {
    pub src_addr: u16,
    pub sequence_number: u32,
}

#[derive(Debug)]
pub struct RelayCache {
    seen: HashSet<FrameKey>,
    order: VecDeque<FrameKey>,
    capacity: usize,
}

#[derive(Debug)]
pub struct ReassemblyCache {
    partials: HashMap<FrameKey, PartialFrame>,
    order: VecDeque<FrameKey>,
    capacity: usize,
}

#[derive(Debug)]
struct PartialFrame {
    chunks: Vec<Option<Vec<u8>>>,
    received: usize,
    received_at: std::time::Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshDecision {
    pub deliver_locally: bool,
    pub relay_frame: Option<ProtocolFrame>,
}

impl RelayCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            seen: HashSet::new(),
            order: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    fn insert_if_new(&mut self, key: FrameKey) -> bool {
        if self.seen.contains(&key) {
            return false;
        }

        self.seen.insert(key);
        self.order.push_back(key);

        while self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }

        true
    }
}

impl ReassemblyCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            partials: HashMap::new(),
            order: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    fn touch(&mut self, key: FrameKey) {
        if !self.partials.contains_key(&key) {
            self.order.push_back(key);
        }

        while self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.partials.remove(&oldest);
            }
        }
    }

    /// Evict partial frames older than `timeout`. Prevents memory leaks when a
    /// fragment is lost in transit and reassembly never completes.
    pub fn prune_stale(&mut self, timeout: std::time::Duration) {
        let now = std::time::Instant::now();
        let stale: Vec<FrameKey> = self
            .partials
            .iter()
            .filter(|(_, v)| now.duration_since(v.received_at) > timeout)
            .map(|(k, _)| *k)
            .collect();
        for key in stale {
            self.partials.remove(&key);
            self.order.retain(|k| k != &key);
        }
    }
}

pub fn process_incoming(
    cache: &mut RelayCache,
    local_addr: u16,
    frame: ProtocolFrame,
) -> MeshDecision {
    let key = FrameKey {
        src_addr: frame.src_addr,
        sequence_number: frame.sequence_number,
    };

    if frame.src_addr == local_addr || !cache.insert_if_new(key) {
        return MeshDecision {
            deliver_locally: false,
            relay_frame: None,
        };
    }

    let deliver_locally = frame.dst_addr == local_addr || frame.dst_addr == BROADCAST_ADDR;
    let relay_frame = if frame.ttl > 1 {
        let mut relayed = frame.clone();
        relayed.ttl -= 1;
        relayed.checksum = 0;
        Some(relayed)
    } else {
        None
    };

    MeshDecision {
        deliver_locally,
        relay_frame,
    }
}

pub fn derive_node_addr() -> u16 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::process::id().hash(&mut h);
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        .hash(&mut h);
    let id = (h.finish() & 0xffff) as u16;
    match id {
        0 => 1,
        BROADCAST_ADDR => 0xfffe,
        x => x,
    }
}

pub fn encode(frame: &ProtocolFrame) -> Vec<u8> {
    let payload_len = frame.payload.len().min(u16::MAX as usize);
    let mut out = Vec::with_capacity(HEADER_LEN + payload_len);
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    out.push(frame.ttl);
    out.extend_from_slice(&frame.src_addr.to_be_bytes());
    out.extend_from_slice(&frame.dst_addr.to_be_bytes());
    out.extend_from_slice(&frame.sequence_number.to_be_bytes());
    out.extend_from_slice(&frame.opcode.to_be_bytes());
    out.extend_from_slice(&(payload_len as u16).to_be_bytes());
    out.extend_from_slice(&[0, 0]); // checksum placeholder
    out.extend_from_slice(&frame.payload[..payload_len]);

    let crc = checksum(&out);
    out[18..20].copy_from_slice(&crc.to_be_bytes());
    out
}

pub fn encode_for_ble_transport(frame: &ProtocolFrame) -> Vec<Vec<u8>> {
    fragment_bytes(&encode(frame), DEFAULT_BLE_PACKET_LEN)
}

/// Like `encode_for_ble_transport` but uses the negotiated ATT MTU from the
/// connected peripheral (pass `peer.mtu() - 3` for the ATT overhead).
/// Falls back to DEFAULT_BLE_PACKET_LEN if mtu is too small.
/// Wired up once btleplug is upgraded to 0.12 (which exposes `peer.mtu()`).
#[allow(dead_code)]
pub fn encode_for_ble_transport_mtu(frame: &ProtocolFrame, mtu: usize) -> Vec<Vec<u8>> {
    let packet_len = mtu.max(DEFAULT_BLE_PACKET_LEN);
    fragment_bytes(&encode(frame), packet_len)
}

pub fn fragment_bytes(bytes: &[u8], packet_len: usize) -> Vec<Vec<u8>> {
    if bytes.len() <= packet_len {
        return vec![bytes.to_vec()];
    }

    let packet_len = packet_len.max(FRAGMENT_HEADER_LEN + 1);
    let payload_len = packet_len - FRAGMENT_HEADER_LEN;
    let total = bytes.len().div_ceil(payload_len).min(u8::MAX as usize);
    let mut packets = Vec::with_capacity(total);

    let frame_src = if bytes.len() >= 8 {
        u16::from_be_bytes([bytes[6], bytes[7]])
    } else {
        0
    };
    let frame_seq = if bytes.len() >= 14 {
        u32::from_be_bytes([bytes[10], bytes[11], bytes[12], bytes[13]])
    } else {
        0
    };

    for index in 0..total {
        let start = index * payload_len;
        let end = (start + payload_len).min(bytes.len());
        let data = &bytes[start..end];
        let mut packet = Vec::with_capacity(FRAGMENT_HEADER_LEN + data.len());
        packet.extend_from_slice(&FRAGMENT_MAGIC);
        packet.extend_from_slice(&frame_src.to_be_bytes());
        packet.extend_from_slice(&frame_seq.to_be_bytes());
        packet.push(index as u8);
        packet.push(total as u8);
        packet.push(data.len() as u8);
        packet.push(0);
        packet.extend_from_slice(data);
        let crc = fragment_checksum(&packet);
        packet[13] = crc;
        packets.push(packet);
    }

    packets
}

pub fn ingest_transport_packet(
    cache: &mut ReassemblyCache,
    bytes: &[u8],
) -> Result<Option<ProtocolFrame>, String> {
    if bytes.starts_with(&MAGIC) {
        return decode(bytes).map(Some);
    }
    if !bytes.starts_with(&FRAGMENT_MAGIC) {
        return Err("protocol: unknown transport packet".to_string());
    }
    if bytes.len() < FRAGMENT_HEADER_LEN {
        return Err("protocol: fragment too short".to_string());
    }

    let src_addr = u16::from_be_bytes([bytes[4], bytes[5]]);
    let sequence_number = u32::from_be_bytes([bytes[6], bytes[7], bytes[8], bytes[9]]);
    let index = bytes[10] as usize;
    let total = bytes[11] as usize;
    let data_len = bytes[12] as usize;
    let expected_crc = bytes[13];

    if total == 0 || total > u8::MAX as usize || index >= total {
        return Err("protocol: invalid fragment index".to_string());
    }
    if bytes.len() != FRAGMENT_HEADER_LEN + data_len {
        return Err("protocol: fragment length mismatch".to_string());
    }
    if fragment_checksum(bytes) != expected_crc {
        return Err("protocol: fragment checksum mismatch".to_string());
    }

    // Evict partial frames that have been waiting more than 5 s — they'll never
    // complete because a fragment was lost. Keep them from accumulating forever.
    cache.prune_stale(std::time::Duration::from_secs(5));

    let key = FrameKey {
        src_addr,
        sequence_number,
    };
    cache.touch(key);

    let partial = cache.partials.entry(key).or_insert_with(|| PartialFrame {
        chunks: vec![None; total],
        received: 0,
        received_at: std::time::Instant::now(),
    });

    if partial.chunks.len() != total {
        cache.partials.remove(&key);
        return Err("protocol: inconsistent fragment total".to_string());
    }

    if partial.chunks[index].is_none() {
        partial.chunks[index] = Some(bytes[FRAGMENT_HEADER_LEN..].to_vec());
        partial.received += 1;
    }

    if partial.received != total {
        return Ok(None);
    }

    let partial = cache
        .partials
        .remove(&key)
        .ok_or_else(|| "protocol: missing partial frame".to_string())?;
    let mut assembled = Vec::new();
    for chunk in partial.chunks {
        assembled.extend(chunk.ok_or_else(|| "protocol: missing fragment".to_string())?);
    }

    decode(&assembled).map(Some)
}

pub fn decode(bytes: &[u8]) -> Result<ProtocolFrame, String> {
    if bytes.len() < HEADER_LEN {
        return Err("protocol: frame too short".to_string());
    }
    if bytes[0..4] != MAGIC {
        return Err("protocol: bad magic".to_string());
    }
    if bytes[4] != VERSION {
        return Err(format!("protocol: unsupported version {}", bytes[4]));
    }

    let payload_len = u16::from_be_bytes([bytes[16], bytes[17]]) as usize;
    let expected = HEADER_LEN + payload_len;
    if bytes.len() != expected {
        return Err(format!(
            "protocol: length mismatch got {} expected {}",
            bytes.len(),
            expected
        ));
    }

    let expected_crc = u16::from_be_bytes([bytes[18], bytes[19]]);
    let actual_crc = checksum(bytes);
    if actual_crc != expected_crc {
        return Err("protocol: checksum mismatch".to_string());
    }

    Ok(ProtocolFrame {
        src_addr: u16::from_be_bytes([bytes[6], bytes[7]]),
        dst_addr: u16::from_be_bytes([bytes[8], bytes[9]]),
        ttl: bytes[5],
        sequence_number: u32::from_be_bytes([bytes[10], bytes[11], bytes[12], bytes[13]]),
        opcode: u16::from_be_bytes([bytes[14], bytes[15]]),
        payload: bytes[HEADER_LEN..].to_vec(),
        checksum: expected_crc,
    })
}

pub fn to_event(frame: ProtocolFrame) -> ProtocolFrameOut {
    ProtocolFrameOut {
        payload_text: String::from_utf8_lossy(&frame.payload).to_string(),
        payload_len: frame.payload.len(),
        src_addr: frame.src_addr,
        dst_addr: frame.dst_addr,
        ttl: frame.ttl,
        sequence_number: frame.sequence_number,
        opcode: frame.opcode,
        checksum: frame.checksum,
    }
}

fn checksum(bytes: &[u8]) -> u16 {
    let mut sum = 0u16;
    for (i, byte) in bytes.iter().enumerate() {
        if i == 18 || i == 19 {
            continue;
        }
        sum = sum.rotate_left(1) ^ (*byte as u16);
    }
    sum
}

fn fragment_checksum(bytes: &[u8]) -> u8 {
    let mut sum = 0u8;
    for (i, byte) in bytes.iter().enumerate() {
        if i == 13 {
            continue;
        }
        sum = sum.rotate_left(1) ^ *byte;
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_protocol_frame() {
        let frame = ProtocolFrame {
            src_addr: 7,
            dst_addr: BROADCAST_ADDR,
            ttl: 3,
            sequence_number: 42,
            opcode: OPCODE_TEXT,
            payload: b"hello".to_vec(),
            checksum: 0,
        };

        let bytes = encode(&frame);
        let decoded = decode(&bytes).unwrap();

        assert_eq!(decoded.src_addr, frame.src_addr);
        assert_eq!(decoded.dst_addr, frame.dst_addr);
        assert_eq!(decoded.ttl, frame.ttl);
        assert_eq!(decoded.sequence_number, frame.sequence_number);
        assert_eq!(decoded.opcode, frame.opcode);
        assert_eq!(decoded.payload, frame.payload);
    }

    #[test]
    fn dedupes_and_decrements_ttl_for_relay() {
        let mut cache = RelayCache::new(64);
        let frame = ProtocolFrame {
            src_addr: 7,
            dst_addr: BROADCAST_ADDR,
            ttl: 3,
            sequence_number: 42,
            opcode: OPCODE_TEXT,
            payload: b"hello".to_vec(),
            checksum: 0,
        };

        let first = process_incoming(&mut cache, 9, frame.clone());
        assert!(first.deliver_locally);
        assert_eq!(first.relay_frame.unwrap().ttl, 2);

        let duplicate = process_incoming(&mut cache, 9, frame);
        assert!(!duplicate.deliver_locally);
        assert!(duplicate.relay_frame.is_none());
    }

    #[test]
    fn proves_three_node_broadcast_path_without_hardware() {
        let node_a = 100;
        let node_b = 200;
        let node_c = 300;
        let mut cache_b = RelayCache::new(64);
        let mut cache_c = RelayCache::new(64);

        let from_a = ProtocolFrame {
            src_addr: node_a,
            dst_addr: BROADCAST_ADDR,
            ttl: 2,
            sequence_number: 1,
            opcode: OPCODE_TEXT,
            payload: b"off-grid".to_vec(),
            checksum: 0,
        };

        let at_b = process_incoming(&mut cache_b, node_b, from_a);
        assert!(at_b.deliver_locally);

        let relayed_by_b = at_b.relay_frame.expect("B should relay one hop");
        assert_eq!(relayed_by_b.ttl, 1);

        let at_c = process_incoming(&mut cache_c, node_c, relayed_by_b);
        assert!(at_c.deliver_locally);
        assert!(at_c.relay_frame.is_none());
    }

    #[test]
    fn fragments_and_reassembles_ble_transport_packets() {
        let frame = ProtocolFrame {
            src_addr: 7,
            dst_addr: BROADCAST_ADDR,
            ttl: 3,
            sequence_number: 99,
            opcode: OPCODE_TEXT,
            payload: b"this payload is intentionally bigger than one tiny ble packet".to_vec(),
            checksum: 0,
        };

        let packets = encode_for_ble_transport(&frame);
        assert!(packets.len() > 1);
        assert!(packets
            .iter()
            .all(|packet| packet.len() <= DEFAULT_BLE_PACKET_LEN));

        let mut cache = ReassemblyCache::new(16);
        let mut decoded = None;
        for packet in packets {
            decoded = ingest_transport_packet(&mut cache, &packet)
                .unwrap()
                .or(decoded);
        }

        assert_eq!(decoded.unwrap().payload, frame.payload);
    }
}
