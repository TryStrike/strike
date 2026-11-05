//! Server-side tick broadcaster that feeds every SSE price connection.
//!
//! One shared loop per process re-quotes the union of every subscribed asset
//! and fans the *changes* out to listeners, so N browser tabs cost one upstream
//! call per tick instead of N. `/api/prices/latest` keeps its own cache-bounded
//! semantics and is untouched by anything here.
//!
//! A hub behind one mutex plus a single spawned task, aborted when the last
//! client leaves. Starting the loop
//! is an explicit call rather than a side effect of subscribing, which keeps the
//! hub testable without a live upstream. The pump awaits its own fetch, so ticks
//! cannot overlap.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};

use tokio::sync::mpsc;

use crate::prices::{self, HEARTBEAT_MS, PRICE_TICK_MS};

pub type FrameTx = mpsc::UnboundedSender<String>;
pub type FrameRx = mpsc::UnboundedReceiver<String>;

/// One registered connection. Dropping it removes the connection from the hub,
/// which is what the SSE handler relies on: the connection ends when the
/// response stream is dropped, whatever ended it.
pub struct Subscription {
    id: u64,
    rx: Option<FrameRx>,
}

impl Subscription {
    pub fn id(&self) -> u64 {
        self.id
    }

    /// Take the frame receiver. Only meaningful once per subscription.
    pub fn frames(&mut self) -> Option<FrameRx> {
        self.rx.take()
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        unsubscribe(self.id);
    }
}

struct Client {
    assets: BTreeSet<String>,
    tx: FrameTx,
}

#[derive(Default)]
struct Hub {
    next_id: u64,
    clients: HashMap<u64, Client>,
    last_sent: BTreeMap<String, f64>,
    pump: Option<tokio::task::JoinHandle<()>>,
    closed: bool,
}

static HUB: OnceLock<Mutex<Hub>> = OnceLock::new();

fn hub() -> &'static Mutex<Hub> {
    HUB.get_or_init(|| Mutex::new(Hub::default()))
}

fn lock_hub() -> std::sync::MutexGuard<'static, Hub> {
    hub()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Live SSE subscriptions in this process (parity with
/// `activePriceStreamClients`).
pub fn active_client_count() -> usize {
    lock_hub().clients.len()
}

/// How many assets currently hold a pushed quote. Diagnostics only; a nonzero
/// count with zero clients means the loop was never reaped.
pub fn deduped_asset_count() -> usize {
    lock_hub().last_sent.len()
}

/// Register a connection's asset interest and return its frame channel.
pub fn subscribe(assets: &[String]) -> Subscription {
    let (tx, rx) = mpsc::unbounded_channel();
    let mut hub = lock_hub();
    let id = hub.next_id;
    hub.next_id += 1;
    // After `close_all` the sender drops here, so the stream ends as it starts.
    if !hub.closed {
        hub.clients.insert(
            id,
            Client {
                assets: assets.iter().cloned().collect(),
                tx,
            },
        );
    }
    Subscription { id, rx: Some(rx) }
}

/// Ends every SSE response, for good: this process is shutting down, and a stream
/// never finishes by itself, so a graceful stop would otherwise wait on each one.
pub fn close_all() {
    let mut hub = lock_hub();
    hub.closed = true;
    hub.clients.clear();
    if let Some(handle) = hub.pump.take() {
        handle.abort();
    }
}

/// Start the shared loop if it is not already running. Called by the SSE
/// handler once at least one client exists; an idle process runs nothing.
pub fn ensure_pump_running() {
    let mut hub = lock_hub();
    if hub.pump.is_some() || hub.clients.is_empty() {
        return;
    }
    hub.pump = Some(tokio::spawn(pump()));
}

fn unsubscribe(id: u64) {
    let mut hub = lock_hub();
    hub.clients.remove(&id);
    if hub.clients.is_empty() {
        // Clearing the dedupe map means a client that comes back is primed
        // again instead of being told "nothing has moved" about a quote it has
        // never seen.
        hub.last_sent.clear();
        if let Some(handle) = hub.pump.take() {
            handle.abort();
        }
    }
}

/// The union of every client's assets: one upstream call covers them all.
pub fn union_of(assets_per_client: impl IntoIterator<Item = BTreeSet<String>>) -> Vec<String> {
    let mut union = BTreeSet::new();
    for client_assets in assets_per_client {
        union.extend(client_assets);
    }
    union.into_iter().collect()
}

/// One pump iteration, pure: given what every client asked for and what the
/// aggregator returned, decide which connection receives which frame.
///
/// A quote is pushed only when it actually moved (exact equality, as the TS
/// did), only once per asset per tick, and never for a price the feed could not
/// produce. `last_sent` is updated in place so the caller owns the dedupe.
pub fn fan_out(
    clients: &[(u64, BTreeSet<String>)],
    last_sent: &mut BTreeMap<String, f64>,
    prices: &BTreeMap<String, f64>,
    ts_ms: i64,
) -> Vec<(u64, String)> {
    let mut moved: Vec<(String, f64)> = Vec::new();
    for (asset, price) in prices {
        if !price.is_finite() || *price <= 0.0 {
            continue;
        }
        if last_sent.get(asset) == Some(price) {
            continue;
        }
        last_sent.insert(asset.clone(), *price);
        moved.push((asset.clone(), *price));
    }

    let mut frames = Vec::new();
    for (asset, price) in moved {
        for (id, client_assets) in clients {
            if client_assets.contains(&asset) {
                frames.push((*id, prices::tick_frame(&asset, price, ts_ms)));
            }
        }
    }
    frames
}

/// Send already-rendered frames to one connection. Returns how many landed; a
/// closed channel means the response is gone and the drop will reap the client.
pub fn deliver(id: u64, frames: &[String]) -> usize {
    let hub = lock_hub();
    match hub.clients.get(&id) {
        Some(client) => frames
            .iter()
            .filter(|frame| client.tx.send((*frame).clone()).is_ok())
            .count(),
        None => 0,
    }
}

/// `: heartbeat 1700000000000\n\n` — a comment line, so an idle proxy sees
/// traffic without the browser dispatching a message event.
pub fn heartbeat_frame(now_ms: i64) -> String {
    format!(": heartbeat {now_ms}\n\n")
}

pub fn tick_interval() -> std::time::Duration {
    std::time::Duration::from_millis(PRICE_TICK_MS)
}

pub fn heartbeat_interval() -> std::time::Duration {
    std::time::Duration::from_millis(HEARTBEAT_MS)
}

/// Prime a fresh connection with the current values, exactly as the TS does in
/// `ReadableStream.start`: issued after subscribing, so a market move that lands
/// during the fetch is still delivered afterwards.
pub fn spawn_prime(id: u64, assets: Vec<String>) {
    let tx = lock_hub().clients.get(&id).map(|client| client.tx.clone());
    let Some(tx) = tx else { return };
    tokio::spawn(async move {
        let prices = prices::fetch_latest_prices(&assets, false).await;
        let ts = prices::now_millis();
        for frame in prices::snapshot_frames_at(&assets, &prices, ts) {
            if tx.send(frame).is_err() {
                return; // the connection hung up before the snapshot landed
            }
        }
    });
}

async fn pump() {
    loop {
        tokio::time::sleep(tick_interval()).await;

        let union = {
            let hub = lock_hub();
            if hub.clients.is_empty() {
                return;
            }
            union_of(hub.clients.values().map(|client| client.assets.clone()))
        };
        if union.is_empty() {
            continue;
        }

        let quotes = prices::fetch_latest_prices(&union, true).await;
        let ts = prices::now_millis();

        let mut hub = lock_hub();
        // Re-derive the client list under the lock: a connection can have left
        // while the quote was in flight.
        let live: Vec<(u64, BTreeSet<String>)> = hub
            .clients
            .iter()
            .map(|(id, client)| (*id, client.assets.clone()))
            .collect();
        if live.is_empty() {
            return;
        }
        for (id, frame) in fan_out(&live, &mut hub.last_sent, &quotes, ts) {
            if let Some(client) = hub.clients.get(&id) {
                let _ = client.tx.send(frame);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn quotes(pairs: &[(&str, f64)]) -> BTreeMap<String, f64> {
        pairs.iter().map(|(a, p)| (a.to_string(), *p)).collect()
    }

    #[test]
    fn union_deduplicates_across_clients() {
        let union = union_of(vec![
            set(&["BTC", "ETH"]),
            set(&["ETH", "SOL"]),
            set(&["BTC"]),
        ]);
        assert_eq!(
            union,
            vec!["BTC".to_string(), "ETH".to_string(), "SOL".to_string()]
        );
        assert!(union_of(Vec::<BTreeSet<String>>::new()).is_empty());
    }

    #[test]
    fn fan_out_pushes_only_moves_once_per_asset() {
        let clients = vec![(1u64, set(&["BTC"])), (2u64, set(&["BTC", "ETH"]))];
        let mut last_sent = BTreeMap::new();

        let first = fan_out(&clients, &mut last_sent, &quotes(&[("BTC", 100.0)]), 10);
        assert_eq!(first.len(), 2, "both subscribers of BTC hear the move");

        let unchanged = fan_out(&clients, &mut last_sent, &quotes(&[("BTC", 100.0)]), 11);
        assert!(unchanged.is_empty(), "an identical quote is not a tick");

        assert_eq!(
            fan_out(&clients, &mut last_sent, &quotes(&[("BTC", 100.01)]), 12).len(),
            2
        );
    }

    #[test]
    fn fan_out_only_delivers_to_interested_clients() {
        let clients = vec![(1u64, set(&["BTC"])), (2u64, set(&["ETH"]))];
        let mut last_sent = BTreeMap::new();
        let frames = fan_out(&clients, &mut last_sent, &quotes(&[("ETH", 3000.0)]), 5);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].0, 2);
        assert!(frames[0].1.contains("\"asset\":\"ETH\""));
    }

    #[test]
    fn unusable_quotes_are_never_fanned_out() {
        let clients = vec![(1u64, set(&["BTC", "ETH", "SOL", "XAU"]))];
        let mut last_sent = BTreeMap::new();
        let frames = fan_out(
            &clients,
            &mut last_sent,
            &quotes(&[
                ("BTC", 0.0),
                ("ETH", -1.0),
                ("SOL", f64::NAN),
                ("XAU", f64::INFINITY),
            ]),
            1,
        );
        assert!(frames.is_empty());
        // Nothing was recorded as seen, so a real price next tick still ships.
        assert!(last_sent.is_empty());
    }

    #[test]
    fn tick_frame_matches_the_ts_data_line() {
        let clients = vec![(1u64, set(&["BTC"]))];
        let mut last_sent = BTreeMap::new();
        let frames = fan_out(
            &clients,
            &mut last_sent,
            &quotes(&[("BTC", 67123.45)]),
            1_700_000_000_000,
        );
        assert_eq!(
            frames[0].1,
            "data: {\"asset\":\"BTC\",\"price\":67123.45,\"ts\":1700000000000}\n\n"
        );
    }

    #[test]
    fn heartbeat_is_a_comment_not_an_event() {
        let frame = heartbeat_frame(1_700_000_000_000);
        assert_eq!(frame, ": heartbeat 1700000000000\n\n");
        assert!(frame.starts_with(':'), "must not dispatch as a message");
    }

    #[test]
    fn tick_and_heartbeat_cadences_match_the_ts_constants() {
        assert_eq!(tick_interval(), std::time::Duration::from_millis(250));
        assert_eq!(
            heartbeat_interval(),
            std::time::Duration::from_millis(15_000)
        );
    }

    /// The hub is process-wide and cargo runs tests on several threads, so the
    /// tests that read it take this lock instead of guessing at a delta.
    static TEST_HUB_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn last_client_leaves_no_hub_state_behind() {
        let _serial = TEST_HUB_LOCK.lock().await;

        let mut first = subscribe(&["BTC".to_string()]);
        assert_eq!(active_client_count(), 1);
        assert!(
            first.frames().is_some(),
            "the frame channel is handed out once"
        );
        assert!(first.frames().is_none(), "and cannot be taken twice");

        let second = subscribe(&["ETH".to_string()]);
        assert_eq!(active_client_count(), 2);

        drop(second);
        assert_eq!(
            active_client_count(),
            1,
            "one departure keeps the other alive"
        );

        drop(first);
        assert_eq!(active_client_count(), 0, "the last client reaps the hub");
        assert_eq!(
            deduped_asset_count(),
            0,
            "and clears the dedupe map with it"
        );
    }

    #[tokio::test]
    async fn delivered_frames_reach_the_connected_channel() {
        let _serial = TEST_HUB_LOCK.lock().await;

        let mut sub = subscribe(&["SOL".to_string()]);
        let id = sub.id();
        let mut rx = sub.frames().expect("receiver");

        let sent = deliver(
            id,
            &["data: {\"asset\":\"SOL\",\"price\":1,\"ts\":1}\n\n".to_string()],
        );
        assert_eq!(sent, 1);
        assert_eq!(
            rx.recv().await.unwrap(),
            "data: {\"asset\":\"SOL\",\"price\":1,\"ts\":1}\n\n"
        );

        // A frame for a connection that never existed, or one already gone, is
        // dropped rather than queued.
        assert_eq!(deliver(999_999, &["x".to_string()]), 0);
        let dropped_id = {
            let temp = subscribe(&["XAU".to_string()]);
            temp.id()
        };
        assert_eq!(deliver(dropped_id, &["x".to_string()]), 0);
    }

    #[tokio::test]
    async fn prime_is_a_noop_for_an_unknown_connection() {
        let _serial = TEST_HUB_LOCK.lock().await;

        // Nothing is fetched and nothing is spawned once the client has left.
        spawn_prime(999_998, vec!["BTC".to_string()]);
        tokio::task::yield_now().await;
        assert_eq!(active_client_count(), 0);
    }
}
