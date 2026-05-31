#!/usr/bin/env bash
# Spins up a local mad gateway + 3 clients in Docker, joins them all to
# the same L2 group, and exercises the bridge with the kind of traffic a
# distributed/mesh P2P game produces (multi-port TCP+UDP, broadcast/ARP
# for LAN discovery).

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

GW_ALIAS="mad"
GROUP="stress"
LOG_DIR="$HERE/logs"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

note() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m✘\033[0m %s\n' "$*" >&2; }

note "bring containers up"
docker compose down -t 3 >/dev/null 2>&1 || true
docker compose up -d --build >"$LOG_DIR/compose.log" 2>&1
trap 'docker compose down -t 5 >>"$LOG_DIR/compose.log" 2>&1 || true' EXIT

CLIENTS=(c1 c2 c3)

# Pre-warm known_hosts for the gateway (TOFU on first ssh would block).
for c in "${CLIENTS[@]}"; do
    docker exec "mad-stress-$c" sh -c \
        "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes $GW_ALIAS ca pubkey" \
        >"$LOG_DIR/$c-prewarm.log" 2>&1 || true
done

note "open L2 tunnels in parallel from 3 clients"
for c in "${CLIENTS[@]}"; do
    docker exec -d "mad-stress-$c" sh -c "mad tun join $GW_ALIAS/$GROUP >/work/logs/$c-join.log 2>&1"
done

echo "waiting for tap devices…"
for c in "${CLIENTS[@]}"; do
    for i in $(seq 1 60); do
        if docker exec "mad-stress-$c" sh -c "ip -br addr show dev tap0 2>/dev/null | grep -q 10.55"; then
            ok "$c: tap0 up"
            break
        fi
        sleep 1
        if [ "$i" = 60 ]; then err "$c: tap0 never came up"; cat "$LOG_DIR/$c-join.log"; exit 1; fi
    done
done

declare -A IP
for c in "${CLIENTS[@]}"; do
    IP[$c]="$(docker exec "mad-stress-$c" sh -c "ip -br -4 addr show dev tap0 | awk '{print \$3}' | cut -d/ -f1")"
    echo "  $c → ${IP[$c]}"
done

note "ping mesh (every pair)"
for s in "${CLIENTS[@]}"; do
    for d in "${CLIENTS[@]}"; do
        [ "$s" = "$d" ] && continue
        if docker exec "mad-stress-$s" ping -c 1 -W 3 "${IP[$d]}" >/dev/null 2>&1; then
            ok "$s → $d ($s ${IP[$s]} → ${IP[$d]})"
        else
            err "$s → $d FAILED"
        fi
    done
done

note "ARP broadcast test (proves L2 actually carries broadcast frames)"
docker exec -d mad-stress-c2 sh -c "tcpdump -i tap0 -nn arp -c 1 -w /work/logs/c2-arp.pcap 2>/work/logs/c2-arp.log"
sleep 1
docker exec mad-stress-c1 arping -c 2 -w 3 -I tap0 "${IP[c2]}" >"$LOG_DIR/c1-arping.log" 2>&1 || true
sleep 2
if docker exec mad-stress-c2 sh -c "tcpdump -r /work/logs/c2-arp.pcap 2>/dev/null | grep -q 'Request'"; then
    ok "ARP broadcast from c1 was observed on c2's tap0 (frames are crossing)"
else
    err "ARP broadcast did NOT cross to c2 (L2 broken)"
fi

note "UDP broadcast test (Hamachi-style LAN game discovery)"
docker exec -d mad-stress-c2 sh -c "socat -u UDP4-RECVFROM:55555,broadcast,reuseaddr,fork - >/work/logs/c2-udp.log 2>&1"
docker exec -d mad-stress-c3 sh -c "socat -u UDP4-RECVFROM:55555,broadcast,reuseaddr,fork - >/work/logs/c3-udp.log 2>&1"
sleep 1
docker exec mad-stress-c1 sh -c "echo MAD_BROADCAST_PROBE | socat -u - UDP4-DATAGRAM:10.55.0.255:55555,broadcast" || true
sleep 2
for c in c2 c3; do
    if docker exec "mad-stress-$c" grep -q MAD_BROADCAST_PROBE "/work/logs/$c-udp.log" 2>/dev/null; then
        ok "$c received UDP broadcast from c1"
    else
        err "$c did NOT receive UDP broadcast"
    fi
done

note "multi-port TCP+UDP mesh (iperf3, 10s each)"
# 2 iperf3 servers per host (TCP + UDP) on host-specific ports so each
# --one-off server takes exactly one client. Game traffic patterns:
#   c1 TCP from c2  → c1:5201        c1 UDP from c3  → c1:5211
#   c2 TCP from c3  → c2:5202        c2 UDP from c1  → c2:5212
#   c3 TCP from c1  → c3:5203        c3 UDP from c2  → c3:5213
# UDP rate intentionally modest (5 Mbps) — every byte traverses a WAN
# SSH tunnel + userspace socat on each end.
docker exec -d mad-stress-c1 iperf3 -s -p 5201 --one-off
docker exec -d mad-stress-c1 iperf3 -s -p 5211 --one-off
docker exec -d mad-stress-c2 iperf3 -s -p 5202 --one-off
docker exec -d mad-stress-c2 iperf3 -s -p 5212 --one-off
docker exec -d mad-stress-c3 iperf3 -s -p 5203 --one-off
docker exec -d mad-stress-c3 iperf3 -s -p 5213 --one-off
sleep 1

(docker exec mad-stress-c2 iperf3 -c "${IP[c1]}" -p 5201 -t 10 -J >"$LOG_DIR/c2-to-c1-tcp.json" 2>&1) &
(docker exec mad-stress-c3 iperf3 -c "${IP[c1]}" -p 5211 -t 10 -J -u -b 5M >"$LOG_DIR/c3-to-c1-udp.json" 2>&1) &
(docker exec mad-stress-c3 iperf3 -c "${IP[c2]}" -p 5202 -t 10 -J >"$LOG_DIR/c3-to-c2-tcp.json" 2>&1) &
(docker exec mad-stress-c1 iperf3 -c "${IP[c2]}" -p 5212 -t 10 -J -u -b 5M >"$LOG_DIR/c1-to-c2-udp.json" 2>&1) &
(docker exec mad-stress-c1 iperf3 -c "${IP[c3]}" -p 5203 -t 10 -J >"$LOG_DIR/c1-to-c3-tcp.json" 2>&1) &
(docker exec mad-stress-c2 iperf3 -c "${IP[c3]}" -p 5213 -t 10 -J -u -b 5M >"$LOG_DIR/c2-to-c3-udp.json" 2>&1) &
wait
ok "all 6 mesh flows finished — see logs/*.json"

note "summary"
python3 - <<'PY'
import json, glob, os
LOG = os.path.join(os.path.dirname(__file__) or ".", "logs")
print(f"{'flow':<22} {'proto':<5} {'bps':<14} {'retransmits':<12} {'lost%':<7}")
for f in sorted(glob.glob(os.path.join(LOG, "*-to-*.json"))):
    name = os.path.basename(f).replace(".json", "")
    try:
        d = json.load(open(f))
    except Exception as e:
        print(f"{name:<22} (parse error: {e})")
        continue
    end = d.get("end", {})
    if "sum_received" in end:                     # TCP
        s = end["sum_received"]; r = end.get("sum_sent", {}).get("retransmits", "")
        print(f"{name:<22} TCP   {s['bits_per_second']/1e6:>10.1f}Mbps {r:<12} -")
    elif "sum" in end:                            # UDP
        s = end["sum"]
        loss = (s.get("lost_packets", 0) / max(1, s.get("packets", 1))) * 100
        print(f"{name:<22} UDP   {s['bits_per_second']/1e6:>10.1f}Mbps -            {loss:.2f}%")
PY

note "concurrent join soak (5 sequential re-joins on c1)"
docker exec mad-stress-c1 mad tun leave $GW_ALIAS/$GROUP >>"$LOG_DIR/c1-soak.log" 2>&1 || true
for i in $(seq 1 5); do
    docker exec -d mad-stress-c1 sh -c "mad tun join $GW_ALIAS/$GROUP >>/work/logs/c1-soak.log 2>&1"
    sleep 2
    docker exec mad-stress-c1 mad tun leave $GW_ALIAS/$GROUP >>"$LOG_DIR/c1-soak.log" 2>&1 || true
done
ok "5 join/leave cycles done — see logs/c1-soak.log"

note "done — full logs under tests/stress/logs/"
