// TWSE Market Info (mis.twse.com.tw), the exchange's own public quote feed.
//
// There is no PulseCore source to port here. Taiwan arrived in Pulse for macOS
// 0.15.10, after the app stopped being open source, so what follows is that
// release's behaviour as observed — endpoints, field precedence, pacing and
// the search filter — re-expressed, with the one departure marked where it
// happens.
//
// Unlike Yahoo, one request carries many symbols, so this source is batched.
// It quotes both Taiwanese boards and their two benchmark indices and has no
// candles or intraday series: charts and the row's line stay on Yahoo, which
// also quotes every Taiwanese row and is what remains when this source has no
// price.

.import "SymbolID.js" as SymbolID

var ID = "twse"
var NAME = "TWSE Market Info"
var QUOTE_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
var NAMES_URL = "https://mis.twse.com.tw/stock/api/getStockNames.jsp"

var MARKETS = ["tw", "two"]

// The macOS app spaces requests to this host three seconds apart. Fifty
// channels is well inside what one request answers — 120 was measured.
var DESCRIPTOR = {
  id: ID,
  name: NAME,
  markets: MARKETS,
  capabilities: ["quotes", "search"],
  delay: { tw: 0, two: 0 },
  rateLimit: { minIntervalMs: 3000, batchSize: 50 },
  suggestedPollIntervalMs: 15000
}

var BOARD_PREFIX = { tw: "tse", two: "otc" }
var INDEX_CHANNEL = { taiex: "tse_t00", tpex: "otc_o00" }

function trimmed(value) {
  return String(value === null || value === undefined ? "" : value).replace(/^\s+|\s+$/g, "")
}

// The MIS channel without its `.tw` tail — which is also how a response row
// names itself, as `ex + "_" + c`. MIS ignores Yahoo's `.TWO`: the board is
// the prefix.
function channelKey(symbol) {
  if (!symbol) return null
  if (SymbolID.isIndex(symbol)) return INDEX_CHANNEL[symbol.id] || null
  if (symbol.kind !== SymbolID.KIND_SECURITY) return null
  var prefix = BOARD_PREFIX[symbol.market]
  return prefix ? prefix + "_" + symbol.code : null
}

function supports(symbol) {
  return channelKey(symbol) !== null
}

function batches(symbols) {
  var size = DESCRIPTOR.rateLimit.batchSize
  var out = []
  for (var i = 0; i < symbols.length; i += size) out.push(symbols.slice(i, i + size))
  return out
}

function requestFor(symbols) {
  var channels = []
  for (var i = 0; i < symbols.length; i++) {
    var key = channelKey(symbols[i])
    if (key) channels.push(key + ".tw")
  }
  if (channels.length === 0) return null
  return {
    url: QUOTE_URL + "?ex_ch=" + encodeURIComponent(channels.join("|")) + "&json=1&delay=0&lang=zh_tw",
    channels: channels
  }
}

// MIS sends every number as text, and "-" for "nothing this snapshot".
function positiveNumber(value) {
  var number = parseFloat(trimmed(value))
  return (isFinite(number) && number > 0) ? number : null
}

function quoteFromRow(symbol, row, nowMs) {
  // `z` is the last trade in this snapshot and `pz` the one before it; Pulse
  // for macOS reads them in that order and drops the row when both are "-".
  // During the continuous session they are "-" on almost every snapshot of a
  // stock, and the last trade is only in the nested `trade` object — so in that
  // release most Taiwanese rows fall back to Yahoo's delayed price. Reading
  // `trade.z` last is the one deliberate departure from that release.
  var price = positiveNumber(row.z)
  if (price === null) price = positiveNumber(row.pz)
  if (price === null) price = positiveNumber(row.trade && row.trade.z)
  if (price === null) return null

  var previous = positiveNumber(row.y)
  var lots = parseFloat(trimmed(row.v))
  var tlong = parseFloat(trimmed(row.tlong))
  return {
    symbol: SymbolID.toString(symbol),
    market: symbol.market,
    name: trimmed(row.n) || null,
    currencyCode: SymbolID.currencyCode(symbol),
    price: price,
    previousClose: previous === null ? price : previous,
    open: positiveNumber(row.o),
    high: positiveNumber(row.h),
    low: positiveNumber(row.l),
    // Volume is in lots of a thousand shares; an index has no share count.
    volume: (!SymbolID.isIndex(symbol) && isFinite(lots) && lots >= 0) ? lots * 1000 : null,
    turnover: null,
    sourceID: ID,
    sourceName: NAME,
    sourceDelaySeconds: 0,
    regularSession: null,
    timestampMs: (isFinite(tlong) && tlong > 0) ? tlong : Number(nowMs),
    marketState: "regular"
    // No `series` key: this source has none, and the panel keeps the line
    // another source drew rather than blanking it.
  }
}

// One quote per symbol that MIS priced, in the order asked. A symbol with no
// price is simply absent; the Yahoo quote for it stands.
function parseQuotes(symbols, payload, nowMs) {
  var rows = payload && payload.msgArray
  if (!rows || typeof rows.length !== "number") return []
  var byChannel = {}
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || {}
    if (!row.ex || !row.c) continue
    byChannel[(String(row.ex) + "_" + String(row.c)).toLowerCase()] = row
  }
  var quotes = []
  for (var j = 0; j < symbols.length; j++) {
    var key = channelKey(symbols[j])
    var match = key ? byChannel[key.toLowerCase()] : null
    if (!match) continue
    var quote = quoteFromRow(symbols[j], match, nowMs)
    if (quote) quotes.push(quote)
  }
  return quotes
}

// --- Search ---------------------------------------------------------------

var SEARCH_LIMIT = 12
var BOARD_FROM_PREFIX = { tse: "tw", otc: "two" }
var EXCHANGE_NAMES = { tw: "TWSE", two: "TPEx" }

// The exchange's name index answers codes and Chinese names, which is exactly
// what Yahoo cannot: it answers 400 to Chinese text. A full symbol such as
// `2330.TW` is not asked here, because Yahoo's direct match already resolves it.
function wantsSearch(text) {
  return /^\d{2,6}[A-Za-z]?$/.test(text) || /[㐀-鿿豈-﫿]/.test(text)
}

function searchRequest(query) {
  var text = trimmed(query)
  if (!text || !wantsSearch(text)) return null
  return { url: NAMES_URL + "?n=" + encodeURIComponent(text) + "&lang=zh_tw", query: text }
}

function parseSearch(payload) {
  var items = payload && payload.datas
  if (!items || typeof items.length !== "number") return []
  var results = []
  var seen = {}
  for (var i = 0; i < items.length && results.length < SEARCH_LIMIT; i++) {
    var item = items[i] || {}
    var code = trimmed(item.c).toUpperCase()
    // Six characters and up is where warrants live (03002T, 701064). Pulse
    // for macOS keeps only the ETFs there, and every ETF code starts with 00.
    if (code.length >= 6 && code.indexOf("00") !== 0) continue
    // The key says the board: `tse_2330.tw_20261002` or `otc_6488.tw_…`.
    var market = BOARD_FROM_PREFIX[String(item.key || "").split("_")[0].toLowerCase()]
    if (!market) continue
    var symbol = SymbolID.create(market, code)
    if (!symbol) continue
    var key = SymbolID.toString(symbol)
    if (seen[key]) continue
    seen[key] = true
    results.push({
      key: key,
      symbol: symbol,
      displayCode: SymbolID.displayCode(symbol),
      market: market,
      name: trimmed(item.n) || key,
      exchangeName: EXCHANGE_NAMES[market],
      type: code.indexOf("00") === 0 ? "etf" : "equity"
    })
  }
  return results
}

if (typeof module !== "undefined") module.exports = {
  ID: ID,
  NAME: NAME,
  DESCRIPTOR: DESCRIPTOR,
  channelKey: channelKey,
  supports: supports,
  batches: batches,
  requestFor: requestFor,
  parseQuotes: parseQuotes,
  searchRequest: searchRequest,
  parseSearch: parseSearch
}
