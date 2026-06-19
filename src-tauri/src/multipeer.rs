// ── Off-grid radio: Apple Multipeer Connectivity ─────────────────────────────────
// AWDL (peer-to-peer Wi-Fi) + Bluetooth — no IP, no AP, no router. This is a dumb
// broadcast byte-pipe for the mesh: frames go to every connected peer; received frames
// are emitted to the webview as `mesh-radio-frame` (the TS TauriRadioTransport drives
// presence/dedup/relay on top). Auto-connect: every node advertises AND browses the
// same service type and invites whoever it finds.
//
// NOTE: written without a Mac to compile on — objc2 method/feature names may need
// small fixes on the first build. Keep this isolated so the rest keeps working.

use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_foundation::{NSData, NSObject, NSObjectProtocol, NSString};
use objc2_multipeer_connectivity::{
    MCNearbyServiceAdvertiser, MCNearbyServiceAdvertiserDelegate, MCNearbyServiceBrowser,
    MCNearbyServiceBrowserDelegate, MCPeerID, MCSession, MCSessionDelegate, MCSessionSendDataMode,
    MCSessionState,
};
use tauri::{AppHandle, Emitter};

// Service type: <=15 chars, only [a-z0-9-]. Nodes only find others with the same type.
const SERVICE_TYPE: &str = "levelup-mesh";

struct Ivars {
    app: AppHandle,
    session: Retained<MCSession>,
    my_name: String,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "LevelupMeshDelegate"]
    #[ivars = Ivars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl MCSessionDelegate for Delegate {
        #[unsafe(method(session:peer:didChangeState:))]
        fn did_change_state(&self, _session: &MCSession, _peer: &MCPeerID, state: MCSessionState) {
            // 2 = connected. Surface connection changes for debugging.
            let _ = self.ivars().app.emit("mesh-radio-state", state.0 as i64);
        }

        #[unsafe(method(session:didReceiveData:fromPeer:))]
        fn did_receive_data(&self, _session: &MCSession, data: &NSData, _peer: &MCPeerID) {
            let bytes = data.to_vec();
            let _ = self.ivars().app.emit("mesh-radio-frame", bytes);
        }

        #[unsafe(method(session:didReceiveStream:withName:fromPeer:))]
        fn did_receive_stream(
            &self,
            _s: &MCSession,
            _stream: &NSObject,
            _name: &NSString,
            _peer: &MCPeerID,
        ) {
        }

        #[unsafe(method(session:didStartReceivingResourceWithName:fromPeer:withProgress:))]
        fn did_start_resource(
            &self,
            _s: &MCSession,
            _name: &NSString,
            _peer: &MCPeerID,
            _progress: &NSObject,
        ) {
        }

        #[unsafe(method(session:didFinishReceivingResourceWithName:fromPeer:atURL:withError:))]
        fn did_finish_resource(
            &self,
            _s: &MCSession,
            _name: &NSString,
            _peer: &MCPeerID,
            _url: Option<&NSObject>,
            _err: Option<&NSObject>,
        ) {
        }
    }

    unsafe impl MCNearbyServiceAdvertiserDelegate for Delegate {
        #[unsafe(method(advertiser:didReceiveInvitationFromPeer:withContext:invitationHandler:))]
        fn did_receive_invitation(
            &self,
            _advertiser: &MCNearbyServiceAdvertiser,
            _peer: &MCPeerID,
            _context: Option<&NSData>,
            handler: &block2::Block<dyn Fn(Bool, *mut MCSession)>,
        ) {
            // Auto-accept into our session.
            let session = Retained::as_ptr(&self.ivars().session) as *mut MCSession;
            handler.call((Bool::new(true), session));
        }
    }

    unsafe impl MCNearbyServiceBrowserDelegate for Delegate {
        #[unsafe(method(browser:foundPeer:withDiscoveryInfo:))]
        fn found_peer(
            &self,
            browser: &MCNearbyServiceBrowser,
            peer: &MCPeerID,
            _info: Option<&NSObject>,
        ) {
            // Glare control: every node advertises AND browses, so A finds B and B finds A
            // at the same instant. If both invite, Multipeer flaps (cross/duplicate sessions,
            // connect→disconnect churn). Tiebreak by display name — only the lexicographically
            // smaller side initiates; the other auto-accepts in did_receive_invitation. Equal
            // names are rare (the TS layer passes unique node ids); there we fall back to both
            // inviting, i.e. the previous behaviour, so two nodes never both stay silent.
            unsafe {
                let their_name = peer.displayName().to_string();
                if self.ivars().my_name <= their_name {
                    browser.invitePeer_toSession_withContext_timeout(
                        peer,
                        &self.ivars().session,
                        None,
                        30.0,
                    );
                }
            }
        }

        #[unsafe(method(browser:lostPeer:))]
        fn lost_peer(&self, _browser: &MCNearbyServiceBrowser, _peer: &MCPeerID) {}
    }
);

struct Radio {
    session: Retained<MCSession>,
    advertiser: Retained<MCNearbyServiceAdvertiser>,
    browser: Retained<MCNearbyServiceBrowser>,
    _delegate: Retained<Delegate>,
    _peer: Retained<MCPeerID>,
}
// The objc objects live for the whole session and are only touched under the Mutex.
unsafe impl Send for Radio {}

static RADIO: Mutex<Option<Radio>> = Mutex::new(None);

pub fn start(app: AppHandle, peer_id: Option<String>) -> Result<(), String> {
    let mut guard = RADIO.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    let name: String = peer_id
        .unwrap_or_else(|| "levelup-node".to_string())
        .chars()
        .take(60)
        .collect();
    let display = NSString::from_str(&name);
    let service = NSString::from_str(SERVICE_TYPE);

    unsafe {
        let peer = MCPeerID::initWithDisplayName(MCPeerID::alloc(), &display);
        let session = MCSession::initWithPeer(MCSession::alloc(), &peer);

        let delegate = {
            let this = Delegate::alloc().set_ivars(Ivars {
                app: app.clone(),
                session: session.clone(),
                my_name: name.clone(),
            });
            let this: Retained<Delegate> = msg_send![super(this), init];
            this
        };
        session.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));

        let advertiser = MCNearbyServiceAdvertiser::initWithPeer_discoveryInfo_serviceType(
            MCNearbyServiceAdvertiser::alloc(),
            &peer,
            None,
            &service,
        );
        advertiser.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        advertiser.startAdvertisingPeer();

        let browser = MCNearbyServiceBrowser::initWithPeer_serviceType(
            MCNearbyServiceBrowser::alloc(),
            &peer,
            &service,
        );
        browser.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        browser.startBrowsingForPeers();

        *guard = Some(Radio {
            session,
            advertiser,
            browser,
            _delegate: delegate,
            _peer: peer,
        });
    }
    eprintln!("[mesh_radio] Multipeer up — advertising + browsing '{SERVICE_TYPE}' as '{name}'");
    Ok(())
}

pub fn send(data: Vec<u8>) -> Result<(), String> {
    let guard = RADIO.lock().unwrap();
    let radio = guard
        .as_ref()
        .ok_or_else(|| "mesh_radio: not started".to_string())?;
    unsafe {
        let peers = radio.session.connectedPeers();
        if peers.is_empty() {
            return Ok(());
        }
        let nsdata = NSData::with_bytes(&data);
        radio
            .session
            .sendData_toPeers_withMode_error(&nsdata, &peers, MCSessionSendDataMode::Reliable)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn stop() -> Result<(), String> {
    let mut guard = RADIO.lock().unwrap();
    if let Some(radio) = guard.take() {
        unsafe {
            radio.advertiser.stopAdvertisingPeer();
            radio.browser.stopBrowsingForPeers();
            radio.session.disconnect();
        }
    }
    Ok(())
}
