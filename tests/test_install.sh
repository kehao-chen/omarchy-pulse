#!/usr/bin/env bash
# install.sh, exercised against a throwaway XDG_CONFIG_HOME with omarchy and
# omarchy-shell stubbed out. It checks the things that actually go wrong:
# where the symlink lands, whether a real watchlist survives a reinstall, and
# whether a first install ends up enabled.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The shell rescans plugins asynchronously: `rescanPlugins` returns at once,
# and `enable` answers "unknown" until the scan has found the new plugin. The
# stub reproduces that by failing the first $ENABLE_FAILS enables.
mkdir -p "$work/bin"
cat > "$work/bin/omarchy" <<'STUB'
#!/usr/bin/env bash
if [[ "$1 $2" == "plugin enable" ]]; then
  calls=$(( $(cat "$STUB_STATE/enable-calls" 2>/dev/null || echo 0) + 1 ))
  echo "$calls" > "$STUB_STATE/enable-calls"
  if (( calls <= ${ENABLE_FAILS:-0} )); then
    echo "omarchy-plugin-enable: plugin '$3' is not known; run: omarchy-shell shell rescanPlugins" >&2
    exit 1
  fi
  echo "Enabled $3"
fi
exit 0
STUB
cat > "$work/bin/omarchy-shell" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$work/bin/omarchy" "$work/bin/omarchy-shell"
mkdir -p "$work/state"
export STUB_STATE="$work/state"
export PULSE_ENABLE_INTERVAL=0

export PATH="$work/bin:$PATH"
export XDG_CONFIG_HOME="$work/config"

plugin_link="$XDG_CONFIG_HOME/omarchy/plugins/pulse.omarchy"
watchlist="$XDG_CONFIG_HOME/omarchy/pulse/watchlist.json"

bash "$root/install.sh" --no-restart >/dev/null

[[ -L "$plugin_link" ]] || { echo "FAIL: no symlink at $plugin_link" >&2; exit 1; }
[[ "$(readlink -f "$plugin_link")" == "$root" ]] || { echo "FAIL: symlink points elsewhere" >&2; exit 1; }
[[ -f "$watchlist" ]] || { echo "FAIL: watchlist was not seeded" >&2; exit 1; }

# The watchlist is the one thing here the user owns. A reinstall must not touch it.
printf '{"version":1,"symbols":["MINE"]}' > "$watchlist"
bash "$root/install.sh" --no-restart >/dev/null
grep -q MINE "$watchlist" || { echo "FAIL: reinstall overwrote the user's watchlist" >&2; exit 1; }

# A stale real directory in the plugin slot is moved out of the plugins tree
# entirely — a backup left beside it would be a second plugin with the same id.
rm "$plugin_link"
mkdir -p "$plugin_link"
touch "$plugin_link/manifest.json"
bash "$root/install.sh" --no-restart >/dev/null
[[ -L "$plugin_link" ]] || { echo "FAIL: stale directory was not replaced" >&2; exit 1; }
backups=$(find "$XDG_CONFIG_HOME/omarchy/plugin-backups" -maxdepth 1 -name 'pulse.omarchy.bak.*' | wc -l)
[[ "$backups" -eq 1 ]] || { echo "FAIL: expected one backup outside the plugins tree, found $backups" >&2; exit 1; }
[[ -z "$(find "$XDG_CONFIG_HOME/omarchy/plugins" -maxdepth 1 -name '*.bak.*')" ]] \
  || { echo "FAIL: a backup was left inside the plugins tree" >&2; exit 1; }

# A first install races the shell's rescan. Enabling is retried until the scan
# has caught up, so the plugin ends up enabled rather than silently left off.
rm -f "$STUB_STATE/enable-calls"
ENABLE_FAILS=3 bash "$root/install.sh" --no-restart >/dev/null 2>"$work/stderr"
[[ "$(cat "$STUB_STATE/enable-calls")" -eq 4 ]] \
  || { echo "FAIL: enable was not retried until the shell knew the plugin" >&2; exit 1; }
[[ ! -s "$work/stderr" ]] || { echo "FAIL: a retried enable that succeeded still warned" >&2; exit 1; }

# If it never succeeds, the install still lands but says so, with the command
# to run, instead of swallowing the failure.
rm -f "$STUB_STATE/enable-calls"
ENABLE_FAILS=1000 bash "$root/install.sh" --no-restart >/dev/null 2>"$work/stderr"
grep -q "omarchy plugin enable pulse.omarchy" "$work/stderr" \
  || { echo "FAIL: a failed enable was not reported" >&2; exit 1; }
grep -q "is not known" "$work/stderr" \
  || { echo "FAIL: the enable error itself was not shown" >&2; exit 1; }

# The example watchlist has to parse, and every symbol in it has to resolve —
# it is the first thing a new install shows.
node -e '
const fs = require("fs")
const SymbolID = require(process.argv[1] + "/tests/qmljs.js").load("SymbolID.js")
const config = JSON.parse(fs.readFileSync(process.argv[1] + "/watchlist.example.json", "utf8"))
const symbols = (config.lists || [{symbols: config.symbols}]).flatMap(l => l.symbols)
for (const raw of symbols) {
  if (!SymbolID.parse(raw)) { console.error("FAIL: example watchlist has an unresolvable symbol: " + raw); process.exit(1) }
}
if (!SymbolID.parse(config.pinnedSymbol)) { console.error("FAIL: example pinnedSymbol does not resolve"); process.exit(1) }
' "$root"

echo "install checks passed"
