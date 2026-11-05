//! The copilot: Claude Haiku over the Messages API with fixed tools. It reads
//! market data and moves the UI, and has no tool that touches money. The server
//! keeps no conversation: the client sends its last messages every time.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::config::config;
use crate::prices;
use crate::ticks::TickBuffer;

pub const MODEL: &str = "claude-haiku-5-5";
pub const API_VERSION: &str = "2026-10-21";
pub const MAX_TOOL_TURNS: usize = 4;
pub const MAX_MESSAGES: usize = 10;
const MAX_CHARS: usize = 2_000;
pub const QUESTIONS_PER_MINUTE: usize = 10;
const MOVERS_WINDOW_MS: i64 = 15 * 60 * 1000;
/// A mover needs at least this much of the window covered by ticks.
const MIN_COVERAGE_MS: i64 = 5_000;
/// A quote older than this is not a live price.
const STALE_MS: i64 = 60_000;
const TOP_MOVERS: usize = 10;

pub const TOO_MANY_TOOL_TURNS: &str = "The copilot stopped after 4 tool calls without an answer";
pub const RATE_LIMITED: &str = "Copilot limit is 10 questions a minute. Try again shortly.";

const SYSTEM: &str = "You are the Strike copilot, inside a binary options app on Arc. \
Answer in two or three short sentences. Use only numbers your tools return, never guess a price. \
Movers cover the last 15 minutes of live ticks, so always say \"last 15 minutes\" when you rank them. \
To show movers as a table, call show_table with source market_movers. \
fill_trade_ticket only fills the ticket: tell the trader to tap Higher or Lower to place it. \
Your earlier answers were true when you gave them. The tool calls behind them are not repeated in the history, so never correct them for that. \
Only if the trader asks you to place a bet, change a limit or move funds, say you can't.";

/// The request for one turn. Strict schemas, so tool inputs always validate.
/// The ticket can change between questions, so its state is told fresh each
/// time instead of left for the model to remember from earlier answers.
pub fn request(messages: &[Value], ticket_open: bool) -> Value {
    let ticket = if ticket_open {
        "Right now the trader has a filled trade ticket open, so open_page and open_market will refuse."
    } else {
        "Right now no trade ticket is open."
    };
    json!({
        "model": MODEL,
        "max_tokens": 4_000,
        "stream": true,
        "output_config": { "effort": "low" },
        "system": format!("{SYSTEM} {ticket}"),
        "tools": tools(),
        "messages": messages,
    })
}

/// Pages the copilot may open. Admin is never one of them.
pub const PAGES: [&str; 6] = [
    "/",
    "/trade",
    "/history",
    "/agent",
    "/referrals",
    "/withdrawals",
];
const TICKET_SECONDS: [i64; 5] = [5, 10, 15, 30, 60];
const MAX_TICKET_AMOUNT: f64 = 1_000.0;
const CHART_POINTS: usize = 120;
pub const NAVIGATION_BLOCKED: &str =
    "The trader has a trade ticket open, so the copilot can't navigate away";

/// Every asset some upstream quotes: the only symbols a tool accepts.
pub fn symbols() -> Vec<String> {
    prices::default_assets()
        .into_iter()
        .filter(|a| prices::is_quoted(a))
        .collect()
}

fn tool(name: &str, description: &str, properties: Value) -> Value {
    let required: Vec<&String> = properties
        .as_object()
        .map(|p| p.keys().collect())
        .unwrap_or_default();
    json!({
        "name": name,
        "description": description,
        "strict": true,
        "input_schema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        },
    })
}

/// The fixed tool list. Read only or UI only: nothing bets, changes a limit or
/// moves funds.
fn tools() -> Value {
    let symbol = json!({ "type": "string", "enum": symbols() });
    json!([
        tool(
            "get_market_movers",
            "Percent change of every listed asset over the last 15 minutes of live ticks, biggest moves first.",
            json!({}),
        ),
        tool(
            "get_market_trend",
            "One asset over the last 15 minutes of live ticks: price now, percent change, high and low.",
            json!({ "symbol": symbol }),
        ),
        tool(
            "show_table",
            "Open a table over the site. The server fills the rows from the named source.",
            json!({
                "source": { "type": "string", "enum": ["market_movers"] },
                "title": { "type": "string" },
            }),
        ),
        tool(
            "show_chart",
            "Open a price chart of one asset over the site. The server fills the last 15 minutes of ticks.",
            json!({ "symbol": symbol }),
        ),
        tool(
            "open_page",
            "Navigate to one of the app's pages.",
            json!({ "page": { "type": "string", "enum": PAGES } }),
        ),
        tool(
            "open_market",
            "Open the trade screen on one asset.",
            json!({ "symbol": symbol }),
        ),
        tool(
            "fill_trade_ticket",
            "Fill the trade ticket on the trade screen. It never places the bet: the trader still taps Higher or Lower. Amount is in USDC.",
            json!({
                "symbol": symbol,
                "direction": { "type": "string", "enum": ["UP", "DOWN"] },
                "amount": { "type": "number" },
                "seconds": { "type": "integer", "enum": TICKET_SECONDS },
            }),
        ),
    ])
}

/// The client's last messages as Messages API turns, or why they can't be.
pub fn conversation(body: &Value) -> Result<Vec<Value>, String> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .filter(|m| (1..=MAX_MESSAGES).contains(&m.len()))
        .ok_or_else(|| format!("Send between 1 and {MAX_MESSAGES} messages"))?;
    let mut turns = Vec::with_capacity(messages.len());
    for message in messages {
        let role = message.get("role").and_then(Value::as_str);
        let content = message.get("content").and_then(Value::as_str);
        let (Some(role @ ("user" | "assistant")), Some(content)) = (role, content) else {
            return Err("Each message needs a user or assistant role and text content".into());
        };
        if content.trim().is_empty() || content.chars().count() > MAX_CHARS {
            return Err(format!("Each message must be 1 to {MAX_CHARS} characters"));
        }
        turns.push(json!({ "role": role, "content": content }));
    }
    if turns[0]["role"] != "user" || turns[turns.len() - 1]["role"] != "user" {
        return Err("The conversation must start and end with a user message".into());
    }
    Ok(turns)
}

/// Every listed asset's change over the last 15 minutes, biggest moves first.
pub fn movers(ring: &TickBuffer, now_ms: i64) -> Vec<Value> {
    let mut rows: Vec<(f64, Value)> = prices::default_assets()
        .iter()
        .filter_map(|asset| {
            let last = ring
                .latest(asset)
                .filter(|t| now_ms - t.at_ms <= STALE_MS)?;
            let first = ring.first_since(asset, now_ms - MOVERS_WINDOW_MS)?;
            if last.at_ms - first.at_ms < MIN_COVERAGE_MS || first.price <= 0.0 {
                return None;
            }
            let change = ((last.price - first.price) / first.price * 10_000.0).round() / 100.0;
            let row = json!({
                "asset": asset,
                "changePct": change,
                "price": last.price,
                "windowSecs": (last.at_ms - first.at_ms) / 1_000,
            });
            Some((change.abs(), row))
        })
        .collect();
    rows.sort_by(|a, b| b.0.total_cmp(&a.0));
    rows.into_iter()
        .take(TOP_MOVERS)
        .map(|(_, row)| row)
        .collect()
}

/// What one question's tools share: the market as it stood when asked, and
/// whether the trader has a ticket open.
pub struct Desk<'a> {
    pub ring: &'a TickBuffer,
    pub now_ms: i64,
    pub ticket_open: bool,
    movers: Option<Vec<Value>>,
}

/// What a tool call produced: the result the model reads, and the UI action
/// for the client, if any.
pub struct Ran {
    pub content: String,
    pub is_error: bool,
    pub action: Option<Value>,
}

impl<'a> Desk<'a> {
    pub fn new(ring: &'a TickBuffer, now_ms: i64, ticket_open: bool) -> Self {
        Self {
            ring,
            now_ms,
            ticket_open,
            movers: None,
        }
    }

    fn movers(&mut self) -> Vec<Value> {
        let (ring, now) = (self.ring, self.now_ms);
        self.movers.get_or_insert_with(|| movers(ring, now)).clone()
    }

    pub fn run(&mut self, tool: &ToolUse) -> Ran {
        let ran = match tool.name.as_str() {
            "get_market_movers" => Ok((
                json!({ "window": "last 15 minutes", "movers": self.movers() }).to_string(),
                None,
            )),
            "get_market_trend" => symbol(&tool.input)
                .and_then(|s| trend(self.ring, &s, self.now_ms))
                .map(|t| (t.to_string(), None)),
            "show_table" => table_action(&tool.input, &self.movers())
                .map(|a| ("The table is open for the trader".to_string(), Some(a))),
            "show_chart" => symbol(&tool.input)
                .and_then(|s| chart_action(self.ring, &s, self.now_ms))
                .map(|a| ("The chart is open for the trader".to_string(), Some(a))),
            "open_page" | "open_market" if self.ticket_open => Err(NAVIGATION_BLOCKED.to_string()),
            "open_page" => page(&tool.input).map(|p| {
                (
                    format!("Opened {p}"),
                    Some(json!({ "type": "open_page", "page": p })),
                )
            }),
            "open_market" => symbol(&tool.input).map(|s| {
                (
                    format!("Opened the {s} market"),
                    Some(json!({ "type": "open_market", "symbol": s })),
                )
            }),
            "fill_trade_ticket" => ticket_action(&tool.input).map(|a| {
                (
                    "The ticket is filled. The trader still has to tap to place it".to_string(),
                    Some(a),
                )
            }),
            other => Err(format!("There is no tool called {other}")),
        };
        match ran {
            Ok((content, action)) => Ran {
                content,
                is_error: false,
                action,
            },
            Err(content) => Ran {
                content,
                is_error: true,
                action: None,
            },
        }
    }
}

fn symbol(input: &Value) -> Result<String, String> {
    input
        .get("symbol")
        .and_then(Value::as_str)
        .filter(|s| symbols().iter().any(|known| known == s))
        .map(str::to_string)
        .ok_or_else(|| "That symbol is not on the listed assets".to_string())
}

fn page(input: &Value) -> Result<&'static str, String> {
    let wanted = input
        .get("page")
        .and_then(Value::as_str)
        .unwrap_or_default();
    PAGES
        .into_iter()
        .find(|p| *p == wanted)
        .ok_or_else(|| "That page is not one the copilot can open".to_string())
}

/// One asset over the last 15 minutes of ticks.
fn trend(ring: &TickBuffer, symbol: &str, now_ms: i64) -> Result<Value, String> {
    let ticks = ring.since(symbol, now_ms - MOVERS_WINDOW_MS);
    let none = || format!("No live prices for {symbol} in the last 15 minutes");
    let (Some(first), Some(last)) = (ticks.first(), ticks.last()) else {
        return Err(none());
    };
    if now_ms - last.at_ms > STALE_MS || first.price <= 0.0 {
        return Err(none());
    }
    let (low, high) = ticks
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), t| {
            (lo.min(t.price), hi.max(t.price))
        });
    Ok(json!({
        "symbol": symbol,
        "window": "last 15 minutes",
        "price": last.price,
        "changePct": ((last.price - first.price) / first.price * 10_000.0).round() / 100.0,
        "high": high,
        "low": low,
        "windowSecs": (last.at_ms - first.at_ms) / 1_000,
    }))
}

/// The chart's points come from the ring, at most `CHART_POINTS` of them.
fn chart_action(ring: &TickBuffer, symbol: &str, now_ms: i64) -> Result<Value, String> {
    let ticks = ring.since(symbol, now_ms - MOVERS_WINDOW_MS);
    if ticks.len() < 2 {
        return Err(format!(
            "Not enough live prices for {symbol} to draw a chart yet"
        ));
    }
    let step = ticks.len().div_ceil(CHART_POINTS);
    let mut points: Vec<Value> = ticks
        .iter()
        .step_by(step)
        .map(|t| json!({ "at": t.at_ms, "price": t.price }))
        .collect();
    if !(ticks.len() - 1).is_multiple_of(step) {
        let last = ticks[ticks.len() - 1];
        points.push(json!({ "at": last.at_ms, "price": last.price }));
    }
    Ok(json!({ "type": "show_chart", "symbol": symbol, "points": points }))
}

fn ticket_action(input: &Value) -> Result<Value, String> {
    let symbol = symbol(input)?;
    let direction = input
        .get("direction")
        .and_then(Value::as_str)
        .filter(|d| matches!(*d, "UP" | "DOWN"))
        .ok_or("The direction must be UP or DOWN")?;
    let amount = input
        .get("amount")
        .and_then(Value::as_f64)
        .filter(|a| *a > 0.0 && *a <= MAX_TICKET_AMOUNT && (a * 1e6).fract() == 0.0)
        .ok_or("The amount must be more than 0 and at most 1000 USDC, with at most 6 decimals")?;
    let seconds = input
        .get("seconds")
        .and_then(Value::as_i64)
        .filter(|s| TICKET_SECONDS.contains(s))
        .ok_or("The round must be 5, 10, 15, 30 or 60 seconds")?;
    Ok(json!({
        "type": "fill_trade_ticket",
        "symbol": symbol,
        "direction": direction,
        "amount": amount,
        "seconds": seconds,
    }))
}

/// The typed UI action `show_table` becomes. Rows come from the server.
fn table_action(input: &Value, rows: &[Value]) -> Result<Value, String> {
    if input.get("source").and_then(Value::as_str) != Some("market_movers") {
        return Err("show_table only knows the market_movers source".into());
    }
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty() && t.chars().count() <= 120)
        .ok_or("show_table needs a title of at most 120 characters")?;
    Ok(json!({
        "type": "show_table",
        "title": title,
        "columns": [
            { "key": "asset", "label": "Asset" },
            { "key": "changePct", "label": "Change %" },
            { "key": "price", "label": "Price" },
        ],
        "rows": rows,
    }))
}

/// One streamed assistant turn, rebuilt block by block so it can be sent back
/// unchanged, thinking signatures included.
#[derive(Default)]
pub struct Turn {
    pub blocks: Vec<Value>,
    inputs: Vec<String>,
    pub stop_reason: Option<String>,
}

pub struct ToolUse {
    pub id: String,
    pub name: String,
    pub input: Value,
}

impl Turn {
    /// Applies one stream event. Returns a text delta to forward to the client.
    pub fn apply(&mut self, event: &Value) -> Result<Option<String>, String> {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        match event.get("type").and_then(Value::as_str) {
            Some("content_block_start") => {
                if index != self.blocks.len() {
                    return Err(format!("content block {index} arrived out of order"));
                }
                self.blocks.push(event["content_block"].clone());
                self.inputs.push(String::new());
            }
            Some("content_block_delta") => {
                let block = self
                    .blocks
                    .get_mut(index)
                    .ok_or_else(|| format!("delta for unknown content block {index}"))?;
                let delta = &event["delta"];
                let append = |block: &mut Value, key: &str, piece: &str| {
                    let text = block[key].as_str().unwrap_or_default().to_string() + piece;
                    block[key] = Value::String(text);
                };
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        let text = delta["text"].as_str().unwrap_or_default();
                        append(block, "text", text);
                        return Ok(Some(text.to_string()));
                    }
                    Some("thinking_delta") => append(
                        block,
                        "thinking",
                        delta["thinking"].as_str().unwrap_or_default(),
                    ),
                    Some("signature_delta") => block["signature"] = delta["signature"].clone(),
                    Some("input_json_delta") => self.inputs[index]
                        .push_str(delta["partial_json"].as_str().unwrap_or_default()),
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                if let Some(block) = self.blocks.get_mut(index) {
                    if block["type"] == "tool_use" {
                        let raw = self.inputs[index].trim();
                        block["input"] = if raw.is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(raw)
                                .map_err(|err| format!("tool input was not JSON: {err}"))?
                        };
                    }
                }
            }
            Some("message_delta") => {
                self.stop_reason = event["delta"]["stop_reason"].as_str().map(str::to_string);
            }
            Some("error") => {
                let message = event["error"]["message"].as_str().unwrap_or("stream error");
                return Err(format!("Claude stream failed: {message}"));
            }
            _ => {}
        }
        Ok(None)
    }

    pub fn tool_uses(&self) -> Vec<ToolUse> {
        self.blocks
            .iter()
            .filter(|b| b["type"] == "tool_use")
            .map(|b| ToolUse {
                id: b["id"].as_str().unwrap_or_default().to_string(),
                name: b["name"].as_str().unwrap_or_default().to_string(),
                input: b["input"].clone(),
            })
            .collect()
    }
}

/// A turn that hasn't finished in this long has failed.
const TURN_TIMEOUT: Duration = Duration::from_secs(30);

static CLAUDE: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(TURN_TIMEOUT)
        .build()
        .expect("reqwest client builds")
});

/// One streamed turn. `on_text` gets each answer delta as it arrives, and its
/// `Err` (the client hung up) ends the turn so no more tokens are paid for.
pub async fn stream_turn(
    key: &str,
    messages: &[Value],
    ticket_open: bool,
    mut on_text: impl FnMut(&str) -> Result<(), String>,
) -> Result<Turn, String> {
    let mut res = CLAUDE
        .post(format!("{}/v1/messages", config().anthropic_base_url))
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .json(&request(messages, ticket_open))
        .send()
        .await
        .map_err(|err| format!("Claude API unreachable: {err}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        let message = body["error"]["message"].as_str().unwrap_or("no error body");
        return Err(format!("Claude API returned {status}: {message}"));
    }

    let mut turn = Turn::default();
    // Bytes, not text: a chunk can end inside a multi-byte character.
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|err| format!("Claude stream broke: {err}"))?
    {
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.windows(2).position(|w| w == b"\n\n") {
            let bytes: Vec<u8> = buffer.drain(..end + 2).collect();
            let frame = String::from_utf8(bytes)
                .map_err(|_| "Claude sent an event that is not UTF-8".to_string())?;
            let Some(data) = frame.lines().find_map(|l| l.strip_prefix("data: ")) else {
                continue;
            };
            let event: Value = serde_json::from_str(data)
                .map_err(|err| format!("Claude sent an unreadable event: {err}"))?;
            if let Some(text) = turn.apply(&event)? {
                on_text(&text)?;
            }
        }
    }
    if turn.stop_reason.is_none() {
        return Err("Claude stream ended before the turn finished".into());
    }
    Ok(turn)
}

static ASKED: LazyLock<Mutex<HashMap<String, VecDeque<i64>>>> = LazyLock::new(Mutex::default);

/// Takes one question from `key`'s budget of 10 a minute. `false` when spent.
pub fn take_question(key: &str, now_ms: i64) -> bool {
    let mut asked = ASKED.lock().unwrap_or_else(|p| p.into_inner());
    asked.retain(|_, times| times.back().is_some_and(|t| now_ms - t < 60_000));
    let times = asked.entry(key.to_string()).or_default();
    while times.front().is_some_and(|t| now_ms - t >= 60_000) {
        times.pop_front();
    }
    if times.len() >= QUESTIONS_PER_MINUTE {
        return false;
    }
    times.push_back(now_ms);
    true
}
