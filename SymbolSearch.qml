import QtQuick
import "YahooAdapter.js" as Yahoo
import "TWSEAdapter.js" as TWSE
import "Search.js" as Search

// Symbol lookup for the settings view.
//
// Typing is throttled rather than sent per keystroke: Yahoo rate-limits per IP
// and the same budget pays for the quotes on screen. A request already in
// flight is superseded rather than cancelled, and a late response for an older
// query is dropped — otherwise a fast typist sees results for a prefix they
// have already finished typing.
//
// A code or Chinese text also asks the exchange's own name index, which
// answers exactly what Yahoo cannot: Yahoo answers 400 to Chinese text, and
// does not know which Taiwanese board a bare code is on. Its results lead;
// Each lane is tagged with the query it answered, and only lanes that answered
// the query now pending are shown, so two queries' answers never mix. Yahoo's
// faults always speak; its hints speak only when neither lane found anything.
QtObject {
  id: root

  property string query: ""
  property var results: []
  property bool searching: false
  property string message: ""

  property string _pendingQuery: ""
  property string _servedQuery: ""
  property var _yahooResults: []
  property var _twseResults: []
  property string _yahooQuery: ""
  property string _twseQuery: ""
  property string _yahooFault: ""
  property string _yahooHint: ""
  property bool _yahooPending: false
  property bool _twsePending: false

  function clear() {
    root.query = ""
    root._reset()
    debounce.stop()
  }

  function _reset() {
    root._yahooResults = []
    root._twseResults = []
    root._yahooFault = ""
    root._yahooHint = ""
    root._yahooQuery = ""
    root._twseQuery = ""
    root._pendingQuery = ""
    root._yahooPending = false
    root._twsePending = false
    root._publish()
  }

  // Both lanes publish through here, so the list and its message always
  // describe the same answers. Until Yahoo, or the exchange with something to
  // show, has answered the pending query, the previous complete list stays.
  function _publish() {
    var q = root._pendingQuery
    var yahooIn = root._yahooQuery === q
    var twseIn = root._twseQuery === q
    root.searching = root._yahooPending || root._twsePending
    if (!yahooIn && !(twseIn && root._twseResults.length > 0)) return
    root.results = Search.merge([
      twseIn ? root._twseResults : [],
      yahooIn ? root._yahooResults : []
    ])
    if (yahooIn && root._yahooFault !== "") root.message = root._yahooFault
    else if (yahooIn && !root.searching && root.results.length === 0) root.message = root._yahooHint
    else root.message = ""
  }

  function _run(text) {
    var spec = Yahoo.searchRequest(text)
    if (!spec) {
      root._reset()
      return
    }
    root._pendingQuery = spec.query

    var twseSpec = TWSE.searchRequest(spec.query)
    if (!twseSpec) {
      root._twseResults = []
      root._twseQuery = spec.query
    }
    root._twsePending = !!twseSpec
    root._yahooPending = true
    root._publish()

    root._runYahoo(spec)
    if (twseSpec) root._runTwse(twseSpec, spec.query)
  }

  function _runYahoo(spec) {
    var xhr = new XMLHttpRequest()
    xhr.open("GET", spec.url)
    xhr.timeout = 8000
    xhr.setRequestHeader("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) Pulse/0.1 (+https://www.pulseticker.app)")
    xhr.setRequestHeader("Accept", "application/json")
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      // A response for a query the user has moved past is not an answer.
      if (spec.query !== root._pendingQuery) return
      root._yahooPending = false
      root._servedQuery = spec.query
      root._yahooQuery = spec.query
      root._yahooFault = ""
      root._yahooHint = ""

      if (xhr.status === 400) {
        // Yahoo answers 400 to queries its index cannot parse, which includes
        // Chinese, Japanese and Korean text. That is an empty result, not a
        // fault: a code the user typed still resolves locally, and Taiwanese
        // names come from the exchange's own lane.
        root._yahooResults = Yahoo.parseSearch(null, spec.query)
        root._yahooHint = "Yahoo indexes English names and tickers. Try a code, like 600519.SH."
      } else if (xhr.status === 429) {
        root._yahooResults = Yahoo.parseSearch(null, spec.query)
        root._yahooFault = "Rate limited. Try again in a moment."
      } else if (xhr.status < 200 || xhr.status >= 300) {
        root._yahooResults = Yahoo.parseSearch(null, spec.query)
        root._yahooFault = xhr.status === 0 ? "Offline." : ("Search failed (HTTP " + xhr.status + ").")
      } else {
        var parsed = []
        try {
          parsed = Yahoo.parseSearch(JSON.parse(xhr.responseText), spec.query)
        } catch (e) {
          parsed = Yahoo.parseSearch(null, spec.query)
        }
        root._yahooResults = parsed
        root._yahooHint = "Nothing found for “" + spec.query + "”."
      }
      root._publish()
    }
    xhr.send()
  }

  // Silent on failure: Yahoo's lane carries the messaging, and an exchange
  // index that did not answer is simply no extra results.
  function _runTwse(spec, query) {
    var xhr = new XMLHttpRequest()
    xhr.open("GET", spec.url)
    xhr.timeout = 8000
    xhr.setRequestHeader("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) Pulse/0.1 (+https://www.pulseticker.app)")
    xhr.setRequestHeader("Accept", "application/json")
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      if (query !== root._pendingQuery) return
      root._twsePending = false
      var parsed = []
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          parsed = TWSE.parseSearch(JSON.parse(xhr.responseText))
        } catch (e) {
          parsed = []
        }
      }
      root._twseResults = parsed
      root._twseQuery = query
      root._publish()
    }
    xhr.send()
  }

  onQueryChanged: {
    var text = String(root.query || "").replace(/^\s+|\s+$/g, "")
    if (!text) {
      root._reset()
      debounce.stop()
      return
    }
    if (text === root._servedQuery) return
    debounce.restart()
  }

  property Timer debounce: Timer {
    id: debounce
    interval: 350
    repeat: false
    onTriggered: root._run(root.query)
  }
}
