#!/usr/bin/env bash
# Focused perf test: 2 clients (c1, c2), 30s iperf3 runs, both directions.
# Less interleaving than run.sh so the bottleneck is more isolated.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

LOG_DIR="$HERE/logs-perf"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

note() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }

note "ensure containers up"
docker compose up -d >/dev/null 2>&1
sleep 2

note "tear down any prior taps"
for c in c1 c2 c3; do
    docker exec "mad-stress-$c" sh -c "mad tap leave mad/stress 2>/dev/null || true; ip link delete tap0 2>/dev/null || true" >/dev/null 2>&1 || true
done
ssh root@167.114.194.173 'for t in $(ip -br link show 2>/dev/null | awk "/^tap-stress-/ {print \$1}" | cut -d@ -f1); do ip link delete "$t" 2>/dev/null || true; done; python3 -c "import json; s=json.load(open(\"/var/lib/mad/state.json\")); s[\"tuns\"]=[]; [n.update(nextHost=2) for n in s.get(\"netns\",[]) if n[\"group\"]==\"stress\"]; open(\"/var/lib/mad/state.json\",\"w\").write(json.dumps(s, indent=2))" ; systemctl restart mad-daemon' >/dev/null 2>&1
sleep 1

note "open 2 L2 taps"
for c in c1 c2; do
    docker exec -d "mad-stress-$c" sh -c "mad tap join mad/stress >/work/logs-perf/$c-join.log 2>&1"
done
for c in c1 c2; do
    for i in $(seq 1 30); do
        if docker exec "mad-stress-$c" sh -c "ip -br addr show dev tap0 2>/dev/null | grep -q 10.55"; then break; fi
        sleep 1
    done
done
declare -A IP
for c in c1 c2; do
    IP[$c]="$(docker exec "mad-stress-$c" sh -c "ip -br -4 addr show dev tap0 | awk '{print \$3}' | cut -d/ -f1")"
    ok "$c: ${IP[$c]}"
done

note "raw SSH baseline (no tap, 64 MB)"
docker exec mad-stress-c1 sh -c '
start=$(date +%s.%N)
dd if=/dev/zero bs=64k count=1000 status=none 2>/dev/null | ssh -o StrictHostKeyChecking=accept-new mad ca pubkey >/dev/null 2>&1
# fallback: ssh under marc only allows mad subcommands, so we measure
# upload by sending bytes to `ca sign` (which reads stdin)
end=$(date +%s.%N)
elapsed=$(echo "$end - $start" | bc -l)
mbps=$(echo "scale=2; 64*1024*1024*8 / $elapsed / 1000000" | bc -l)
echo "  setup-only ssh trip: ${elapsed}s"
' 2>&1

note "TCP through tap (30s, c1 → c2)"
docker exec -d mad-stress-c2 iperf3 -s -p 5201 --one-off
sleep 1
docker exec mad-stress-c1 iperf3 -c "${IP[c2]}" -p 5201 -t 30 -J >"$LOG_DIR/tcp-c1-c2.json"
ok "done"

note "TCP through tap (30s, c2 → c1)"
docker exec -d mad-stress-c1 iperf3 -s -p 5202 --one-off
sleep 1
docker exec mad-stress-c2 iperf3 -c "${IP[c1]}" -p 5202 -t 30 -J >"$LOG_DIR/tcp-c2-c1.json"
ok "done"

note "UDP through tap (30s, c1 → c2, target 20 Mbps)"
docker exec -d mad-stress-c2 iperf3 -s -p 5203 --one-off
sleep 1
docker exec mad-stress-c1 iperf3 -c "${IP[c2]}" -p 5203 -t 30 -J -u -b 20M >"$LOG_DIR/udp-c1-c2.json"
ok "done"

note "summary"
python3 - <<'PY'
import json, glob, os
LOG = os.path.join(os.path.dirname(__file__) or ".", "logs-perf")
print(f"{'flow':<20} {'proto':<5} {'bps':<12} {'retransmits':<12} {'loss%':<7} {'rtt_avg':<8}")
for f in sorted(glob.glob(os.path.join(LOG, "*.json"))):
    name = os.path.basename(f).replace(".json", "")
    try:
        d = json.load(open(f))
    except Exception as e:
        print(f"{name:<20} parse error: {e}")
        continue
    end = d.get("end", {})
    if "sum_received" in end:
        s = end["sum_received"]
        r = end.get("sum_sent", {}).get("retransmits", "")
        # RTT in iperf3 is per-stream; pull from streams[0]
        rtt = ""
        streams = end.get("streams", [])
        if streams and "sender" in streams[0]:
            rtt = f"{streams[0]['sender'].get('mean_rtt', 0)/1000:.1f}ms"
        print(f"{name:<20} TCP   {s['bits_per_second']/1e6:>7.2f}Mbps  {r:<12} -       {rtt}")
    elif "sum" in end:
        s = end["sum"]
        loss = (s.get("lost_packets", 0) / max(1, s.get("packets", 1))) * 100
        jitter = s.get("jitter_ms", 0)
        print(f"{name:<20} UDP   {s['bits_per_second']/1e6:>7.2f}Mbps  -            {loss:5.2f}%  jit={jitter:.1f}ms")
PY
