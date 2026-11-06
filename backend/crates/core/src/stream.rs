//! Server-side tick broadcaster that feeds every SSE price connection.
//!
//! One shared loop per process reads the newest prices from the rings on a fixed
//! beat and fans the *changes* out as one frame per connection. It never awaits
//! an upstream, so a slow quote can't delay a frame, and N browser tabs cost
//! nothing upstream.
//!
//! A hub behind one mutex plus a single spawned task, aborted when the last
//! client leaves. Starting the loop is an explicit call rather than a side effect
//! of subscribing, which keeps the hub testable. A connection that stops reading
//! fills its bounded channel and misses frames, it never grows memory.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};

use tokio::sync::mpsc;

use crate::prices::{self, HEARTBEAT_MS, PRICE_TICK_MS};
use crate::settlement;
use crate::ticks;

/// About 15 seconds of frames for a client that has stopped reading.
const FRAME_BUFFER: usize = 150;
/// Band limits move slowly, so they ride on one frame a second.
const FRAMES_PER_BAND_UPDATE: u32 = 10;

pub type FrameTx = mpsc::Sender<String>;
pub type FrameRx = mpsc::Receiver<String>;

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
    /// A frame was dropped, so the next one must carry every price.
    behind: bool,
}

impl Client {
    /// Frames carry only moves, so a dropped frame is repaired with a full one.
    fn offer(&mut self, frame: String, full_frame: impl FnOnce(&BTreeSet<String>) -> String) {
        let frame = if self.behind {
            full_frame(&self.assets)
        } else {
            frame
        };
        self.behind = self.tx.try_send(frame).is_err();
    }
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
    let (tx, rx) = mpsc::channel(FRAME_BUFFER);
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
                behind: false,
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

fn only(values: &BTreeMap<String, f64>, assets: &BTreeSet<String>) -> BTreeMap<String, f64> {
    values
        .iter()
        .filter(|(asset, _)| assets.contains(*asset))
        .map(|(asset, value)| (asset.clone(), *value))
        .collect()
}

/// One pump iteration, pure: given what every client asked for and what the rings
/// hold, decide what each connection receives.
///
/// A price is pushed only when it actually moved, and never when the feed could
/// not produce one. `last_sent` is updated in place so the caller owns the dedupe.
pub fn fan_out(
    clients: &[(u64, BTreeSet<String>)],
    last_sent: &mut BTreeMap<String, f64>,
    prices: &BTreeMap<String, f64>,
    bands: &BTreeMap<String, f64>,
    ts_ms: i64,
) -> Vec<(u64, String)> {
    let mut moved = BTreeMap::new();
    for (asset, price) in prices {
        if !price.is_finite() || *price <= 0.0 || last_sent.get(asset) == Some(price) {
            continue;
        }
        last_sent.insert(asset.clone(), *price);
        moved.insert(asset.clone(), *price);
    }

    clients
        .iter()
        .filter_map(|(id, assets)| {
            let prices = only(&moved, assets);
            let bands = only(bands, assets);
            (!prices.is_empty() || !bands.is_empty())
                .then(|| (*id, prices::price_frame(&prices, &bands, ts_ms)))
        })
        .collect()
}

fn band_widths(assets: &[String], now_ms: i64) -> BTreeMap<String, f64> {
    assets
        .iter()
        .map(|asset| {
            let width = settlement::max_band_width(ticks::buffer(), asset, now_ms);
            (asset.clone(), width)
        })
        .filter(|(_, width)| *width > 0.0)
        .collect()
}

/// Send already-rendered frames to one connection. Returns how many landed; a
/// closed channel means the response is gone and the drop will reap the client.
pub fn deliver(id: u64, frames: &[String]) -> usize {
    let hub = lock_hub();
    match hub.clients.get(&id) {
        Some(client) => frames
            .iter()
            .filter(|frame| client.tx.try_send((*frame).clone()).is_ok())
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

/// Prime a fresh connection with the current values, from memory, so a client
/// never waits for a change to get its first prices. Later moves come from the pump.
pub fn prime(id: u64, assets: &[String]) {
    let quotes = prices::ring_quotes(assets);
    if quotes.is_empty() {
        return;
    }
    let now = prices::now_millis();
    let frame = prices::price_frame(&quotes, &band_widths(assets, now), now);
    deliver(id, &[frame]);
}

async fn pump() {
    let mut every = tokio::time::interval(tick_interval());
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut beat = 0u32;
    loop {
        every.tick().await;

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

        beat = beat.wrapping_add(1);
        let quotes = prices::ring_quotes(&union);
        let ts = prices::now_millis();
        let bands = if beat.is_multiple_of(FRAMES_PER_BAND_UPDATE) {
            band_widths(&union, ts)
        } else {
            BTreeMap::new()
        };

        let mut hub = lock_hub();
        let live: Vec<(u64, BTreeSet<String>)> = hub
            .clients
            .iter()
            .map(|(id, client)| (*id, client.assets.clone()))
            .collect();
        let frames = fan_out(&live, &mut hub.last_sent, &quotes, &bands, ts);
        for (id, frame) in frames {
            if let Some(client) = hub.clients.get_mut(&id) {
                client.offer(frame, |assets| {
                    prices::price_frame(&only(&quotes, assets), &only(&bands, assets), ts)
                });
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

    fn none() -> BTreeMap<String, f64> {
        BTreeMap::new()
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

        let first = fan_out(
            &clients,
            &mut last_sent,
            &quotes(&[("BTC", 100.0)]),
            &none(),
            10,
        );
        assert_eq!(first.len(), 2, "both subscribers of BTC hear the move");

        let unchanged = fan_out(
            &clients,
            &mut last_sent,
            &quotes(&[("BTC", 100.0)]),
            &none(),
            11,
        );
        assert!(unchanged.is_empty(), "an identical quote is not a tick");

        assert_eq!(
            fan_out(
                &clients,
                &mut last_sent,
                &quotes(&[("BTC", 100.01)]),
                &none(),
                12
            )
            .len(),
            2
        );
    }

    #[test]
    fn fan_out_only_delivers_to_interested_clients() {
        let clients = vec![(1u64, set(&["BTC"])), (2u64, set(&["ETH"]))];
        let mut last_sent = BTreeMap::new();
        let frames = fan_out(
            &clients,
            &mut last_sent,
            &quotes(&[("ETH", 3000.0)]),
            &none(),
            5,
        );
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].0, 2);
        assert!(frames[0].1.contains("\"ETH\":3000"));
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
            &none(),
            1,
        );
        assert!(frames.is_empty());
        // Nothing was recorded as seen, so a real price next tick still ships.
        assert!(last_sent.is_empty());
    }

    #[test]
    fn a_client_gets_one_frame_with_only_its_own_moves_and_bands() {
        let clients = vec![(1u64, set(&["BTC", "ETH"])), (2u64, set(&["SOL"]))];
        let mut last_sent = BTreeMap::new();
        let frames = fan_out(
            &clients,
            &mut last_sent,
            &quotes(&[("BTC", 10.0), ("ETH", 20.0)]),
            &quotes(&[("ETH", 5.0), ("SOL", 1.0)]),
            7,
        );
        assert_eq!(
            frames,
            vec![
                (
                    1,
                    "data: {\"ts\":7,\"prices\":{\"BTC\":10,\"ETH\":20},\"bands\":{\"ETH\":5}}\n\n"
                        .to_string()
                ),
                (
                    2,
                    "data: {\"ts\":7,\"prices\":{},\"bands\":{\"SOL\":1}}\n\n".to_string()
                ),
            ]
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
    async fn a_client_that_stops_reading_never_grows_its_queue() {
        let _serial = TEST_HUB_LOCK.lock().await;

        let sub = subscribe(&["DOGE".to_string()]);
        let frames: Vec<String> = (0..FRAME_BUFFER + 10).map(|n| n.to_string()).collect();
        assert_eq!(deliver(sub.id(), &frames), FRAME_BUFFER);
    }

    #[test]
    fn a_dropped_frame_is_repaired_by_a_full_one() {
        let (tx, mut rx) = mpsc::channel(1);
        let mut client = Client {
            assets: set(&["BTC"]),
            tx,
            behind: false,
        };
        let full = |_: &BTreeSet<String>| "full".to_string();

        client.offer("first".to_string(), full);
        client.offer("dropped".to_string(), full);
        assert!(client.behind);

        assert_eq!(rx.try_recv().unwrap(), "first");
        client.offer("next".to_string(), full);
        assert_eq!(rx.try_recv().unwrap(), "full");
        assert!(!client.behind);
    }

    #[tokio::test]
    async fn prime_is_a_noop_for_an_unknown_connection() {
        let _serial = TEST_HUB_LOCK.lock().await;

        // Nothing happens once the client has left.
        prime(999_998, &["BTC".to_string()]);
        assert_eq!(active_client_count(), 0);
    }
}
