const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const { load } = require("./qmljs.js")

const TWSE = load("TWSEAdapter.js")
const SymbolID = load("SymbolID.js")

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"))
}

const NOW = 1790904600000

test("only Taiwanese securities and the two indices go to TWSE", () => {
  for (const raw of ["2330.TW", "6488.TWO", "TAIEX.TW", "TPEX.TWO"]) {
    assert.equal(TWSE.supports(SymbolID.parse(raw)), true, raw)
  }
  for (const raw of ["AAPL", "700.HK", "^KS11", "BTC/USDT", "GC"]) {
    assert.equal(TWSE.supports(SymbolID.parse(raw)), false, raw)
  }
})

test("one request carries many channels, named the way MIS names them", () => {
  const symbols = ["2330.TW", "6488.TWO", "TAIEX.TW", "TPEX.TWO", "AAPL"].map(SymbolID.parse)
  const spec = TWSE.requestFor(symbols)
  assert.deepEqual(spec.channels, ["tse_2330.tw", "otc_6488.tw", "tse_t00.tw", "otc_o00.tw"])
  assert.equal(spec.url,
    "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch="
    + "tse_2330.tw%7Cotc_6488.tw%7Ctse_t00.tw%7Cotc_o00.tw&json=1&delay=0&lang=zh_tw")
  assert.equal(TWSE.requestFor([SymbolID.parse("AAPL")]), null)
})

test("batches never exceed the source's batch size", () => {
  const symbols = []
  for (let i = 0; i < 120; i++) symbols.push(SymbolID.create("tw", String(1000 + i)))
  const batches = TWSE.batches(symbols)
  assert.deepEqual(batches.map((b) => b.length), [50, 50, 20])
  assert.deepEqual(TWSE.batches([]), [])
  assert.deepEqual(TWSE.DESCRIPTOR.rateLimit, { minIntervalMs: 3000, batchSize: 50 })
})

test("a price comes from z, then pz, then the nested trade", () => {
  const symbols = ["2330.TW", "0050.TW", "6488.TWO", "TAIEX.TW", "3008.TW", "00679B.TW"].map(SymbolID.parse)
  const quotes = TWSE.parseQuotes(symbols, fixture("twse_quotes.json"), NOW)
  assert.deepEqual(quotes.map((q) => q.symbol), ["2330.TW", "0050.TW", "6488.TWO", "TAIEX.TW"])
  const [tsmc, etf, otc, taiex] = quotes
  assert.equal(tsmc.price, 2505)      // only trade.z carried it
  assert.equal(etf.price, 112.45)     // z
  assert.equal(otc.price, 1080)       // pz
  assert.equal(taiex.price, 48370.27)
})

test("a TWSE quote is real time, in TWD, with lots turned into shares", () => {
  const quotes = TWSE.parseQuotes([SymbolID.parse("2330.TW"), SymbolID.parse("TAIEX.TW")],
    fixture("twse_quotes.json"), NOW)
  const [tsmc, taiex] = quotes
  assert.equal(tsmc.market, "tw")
  assert.equal(tsmc.name, "台積電")
  assert.equal(tsmc.currencyCode, "TWD")
  assert.equal(tsmc.previousClose, 2510)
  assert.equal(tsmc.open, 2505)
  assert.equal(tsmc.high, 2515)
  assert.equal(tsmc.low, 2500)
  assert.equal(tsmc.volume, 3302000)
  assert.equal(tsmc.timestampMs, 1790904479000)
  assert.equal(tsmc.sourceID, "twse")
  assert.equal(tsmc.sourceName, "TWSE Market Info")
  assert.equal(tsmc.sourceDelaySeconds, 0)
  assert.equal(tsmc.marketState, "regular")
  // The source has no intraday series; leaving the key out is how it says so.
  assert.equal(Object.prototype.hasOwnProperty.call(tsmc, "series"), false)
  // Index volume is not a share count.
  assert.equal(taiex.volume, null)
})

test("missing reference fields fall back rather than invent", () => {
  const payload = { msgArray: [{ c: "2330", ex: "tse", z: "2500.0000", y: "-", o: "-" }] }
  const [quote] = TWSE.parseQuotes([SymbolID.parse("2330.TW")], payload, NOW)
  assert.equal(quote.previousClose, 2500)
  assert.equal(quote.open, null)
  assert.equal(quote.timestampMs, NOW)
  assert.deepEqual(TWSE.parseQuotes([SymbolID.parse("2330.TW")], {}, NOW), [])
})

test("search runs for codes and Chinese text, not for English words", () => {
  assert.equal(TWSE.searchRequest("2330").url,
    "https://mis.twse.com.tw/stock/api/getStockNames.jsp?n=2330&lang=zh_tw")
  assert.equal(TWSE.searchRequest("00679b").query, "00679b")
  assert.ok(TWSE.searchRequest("台積"))
  assert.equal(TWSE.searchRequest("nvidia"), null)
  assert.equal(TWSE.searchRequest("2330.TW"), null) // a full symbol is Yahoo's direct match
  assert.equal(TWSE.searchRequest("  "), null)
})

test("search keeps stocks and ETFs on the right board and drops warrants", () => {
  const results = TWSE.parseSearch(fixture("twse_names.json"))
  assert.deepEqual(results.map((r) => r.key), ["2330.TW", "00679B.TWO", "006208.TW", "6488.TWO"])
  assert.equal(results[0].name, "台積電")
  assert.equal(results[0].exchangeName, "TWSE")
  assert.equal(results[0].type, "equity")
  assert.equal(results[1].exchangeName, "TPEx")
  assert.equal(results[1].type, "etf")
  assert.equal(results[1].market, "two")
  assert.deepEqual(TWSE.parseSearch(null), [])
})
