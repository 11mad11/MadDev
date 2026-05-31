#!/usr/bin/env bash
# Side-by-side throughput comparison:
#   - L2 (tap) — broadcast/ARP/non-IP crosses
#   - L3 (tun) — IP-only point-to-point
#   - ssh -L  — direct TCP port forward over the SSH transport, no tap
#
# Each test runs from c1 to the hub. TCP every transport, UDP only on
# tap/tun (ssh -L is TCP-only).

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

LOG_DIR="$HERE/logs-compare"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

GW=mad
HUB_IP=10.55.0.1
DURATION=30        # seconds per test (cwnd needs time to open)
UDP_TARGET=200M    # iperf3 -u -b target

note() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m✘\033[0m %s\n' "$*" >&2; }

reset_state() {
    docker exec mad-stress-c1 sh -c "mad tap leave $GW/stress 2>/dev/null || true; mad tun leave $GW/stress 2>/dev/null || true
        for t in \$(ip -br link show | awk '/^tap[0-9]+|^tun[0-9]+/ {print \$1}' | cut -d@ -f1); do
            ip link delete \"\$t\" 2>/dev/null
        done" >/dev/null 2>&1 || true
    ssh root@167.114.194.173 'for t in $(ip -br link show 2>/dev/null | awk "/^tap-stress-|^tun-stress-/ {print \$1}" | cut -d@ -f1); do ip link delete "$t" 2>/dev/null; done
        python3 -c "import json; s=json.load(open(\"/var/lib/mad/state.json\")); s[\"tuns\"]=[]; [n.update(nextHost=2) for n in s.get(\"netns\",[]) if n[\"group\"]==\"stress\"]; open(\"/var/lib/mad/state.json\",\"w\").write(json.dumps(s, indent=2))"
        systemctl restart mad-daemon' >/dev/null 2>&1
    sleep 1
}

note "ensure containers up"
docker compose up -d >/dev/null 2>&1
sleep 2

# ─────────────────────────────────────────────────────────────────────
note "TAP (L2)"
reset_state
docker exec -d mad-stress-c1 sh -c "mad tap join $GW/stress > /work/logs-compare/tap-join.log 2>&1"
for i in $(seq 1 30); do
    docker exec mad-stress-c1 sh -c "ip -br addr show | grep -q 10.55" && break
    sleep 1
done
IF=$(docker exec mad-stress-c1 sh -c "ip -br addr show | awk '/10\\.55/ {print \$1}'")
ok "tap up: $IF"

ssh root@167.114.194.173 'iperf3 -s -p 5500 --one-off -D'; sleep 1
docker exec mad-stress-c1 iperf3 -c $HUB_IP -p 5500 -t $DURATION -J > "$LOG_DIR/tap-tcp.json" 2>&1
ok "tap TCP done"

ssh root@167.114.194.173 'iperf3 -s -p 5501 --one-off -D'; sleep 1
docker exec mad-stress-c1 iperf3 -c $HUB_IP -p 5501 -t $DURATION -u -b $UDP_TARGET -J > "$LOG_DIR/tap-udp.json" 2>&1
ok "tap UDP done"

# ─────────────────────────────────────────────────────────────────────
note "TUN (L3)"
reset_state
docker exec -d mad-stress-c1 sh -c "mad tun join $GW/stress > /work/logs-compare/tun-join.log 2>&1"
for i in $(seq 1 30); do
    docker exec mad-stress-c1 sh -c "ip -br link show | grep -q '^tun0'" && break
    sleep 1
done
IF=$(docker exec mad-stress-c1 sh -c "ip -br link show | awk '/^tun0/ {print \$1}'")
# L3 is point-to-point with /32 + peer addressing — connect to the
# gateway end of the tunnel, not the bridge IP (which only L2 can reach).
TUN_PEER=$(docker exec mad-stress-c1 sh -c "ip route show dev tun0 | awk '/proto kernel/ {print \$1}'" | head -1 | cut -d/ -f1)
[ -z "$TUN_PEER" ] && TUN_PEER=$(grep -oE 'MAD_TUN_OK \S+ \S+' /home/mad/projects/MadDev/tests/stress/logs-compare/tun-join.log | awk '{print $3}' | cut -d/ -f1)
ok "tun up: $IF, peer=$TUN_PEER"

# Bind to wildcard so we don't care whether the iperf3 server's bind
# matches the route choice.
ssh root@167.114.194.173 "iperf3 -s -B $TUN_PEER -p 5510 --one-off -D"; sleep 1
docker exec mad-stress-c1 iperf3 -c $TUN_PEER -p 5510 -t $DURATION -J > "$LOG_DIR/tun-tcp.json" 2>&1
ok "tun TCP done"

ssh root@167.114.194.173 "iperf3 -s -B $TUN_PEER -p 5511 --one-off -D"; sleep 1
docker exec mad-stress-c1 iperf3 -c $TUN_PEER -p 5511 -t $DURATION -u -b $UDP_TARGET -J > "$LOG_DIR/tun-udp.json" 2>&1
ok "tun UDP done"

# ─────────────────────────────────────────────────────────────────────
note "ssh -L (TCP only)"
reset_state
# Hub iperf3 server bound to 127.0.0.1; c1 forwards local 5520 → hub 127.0.0.1:5500.
ssh root@167.114.194.173 'iperf3 -s -B 127.0.0.1 -p 5520 --one-off -D'; sleep 1
# -N -f: no remote command, daemonize. Forward goes through ForceCommand-protected
# user — mad's sshd has AllowStreamLocalForwarding but here we use TCP forward
# which works as long as the SSH session can negotiate the forward.
docker exec -d mad-stress-c1 sh -c "ssh -N -L 5520:127.0.0.1:5520 $GW > /work/logs-compare/sshL.log 2>&1"
sleep 3
docker exec mad-stress-c1 iperf3 -c 127.0.0.1 -p 5520 -t $DURATION -J > "$LOG_DIR/sshL-tcp.json" 2>&1
docker exec mad-stress-c1 pkill -f "ssh -N -L 5520" 2>/dev/null || true
ok "ssh -L TCP done"

# ─────────────────────────────────────────────────────────────────────
note "summary"
python3 - <<'PY'
import json, glob, os
LOG = os.path.join(os.path.dirname(__file__) or ".", "logs-compare")
print(f"{'transport':<14} {'proto':<5} {'mbps':>8}   {'retr':>6}  {'loss%':>6}  {'jit_ms':>6}  {'mean_rtt_ms':>11}")
for tag, fn in [
    ('TAP (L2)', 'tap-tcp'),
    ('TAP (L2)', 'tap-udp'),
    ('TUN (L3)', 'tun-tcp'),
    ('TUN (L3)', 'tun-udp'),
    ('ssh -L',   'sshL-tcp'),
]:
    f = os.path.join(LOG, fn + '.json')
    try:
        d = json.load(open(f))
    except Exception as e:
        print(f'{tag:<14} {fn:<5} parse error: {e}')
        continue
    if 'error' in d and d['error']:
        print(f'{tag:<14} {fn:<8} ERROR: {d["error"]}')
        continue
    end = d['end']
    proto = d.get('start', {}).get('test_start', {}).get('protocol', '?')
    if proto == 'TCP':
        s = end.get('sum_received', {})
        r = end.get('sum_sent', {}).get('retransmits', 0)
        rtt = 0
        streams = end.get('streams') or []
        if streams and 'sender' in streams[0]:
            rtt = streams[0]['sender'].get('mean_rtt', 0) / 1000
        print(f'{tag:<14} TCP   {s.get("bits_per_second",0)/1e6:>7.1f}   {r:>6}      -        -    {rtt:>8.1f}')
    elif proto == 'UDP':
        s = end.get('sum', {})
        loss = (s.get('lost_packets', 0)/max(1,s.get('packets',1)))*100
        jit = s.get('jitter_ms', 0)
        print(f'{tag:<14} UDP   {s.get("bits_per_second",0)/1e6:>7.1f}        -   {loss:>5.2f}   {jit:>5.1f}       -')
PY
