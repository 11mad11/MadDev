#!/bin/bash
# Run the mad conformity test suite against the docker-compose bench.
# Usage: ./run-tests.sh (inside the directory)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR"

declare -i PASS=0 FAIL=0
report() {
    if [ "$1" = "pass" ]; then
        echo "  ✓ $2"; PASS+=1
    else
        echo "  ✗ $2 — $3"; FAIL+=1
    fi
}

# Pull a client's tun-side IP out of its mad-client.log. The log has
#   "MAD_TUN_OK tun-XX-N <gw_ip>/32 peer=<our_ip>/32 group=<g> mode=l3"
# and we want our_ip (without prefix).
client_ip() {
    docker exec "madtest-$1" sh -c "grep -oE 'peer=[0-9.]+/' /var/log/mad-client.log | head -1 | sed 's|peer=||;s|/||'" 2>/dev/null
}

# ---- test 0: every client joined --------------------------------------
echo "Test 0: all clients joined the mad network"
for u in alice bob carol dave; do
    ip=$(client_ip "$u")
    if [ -n "$ip" ]; then
        report pass "$u joined ($ip)"
    else
        report fail "$u joined" "no MAD_TUN_OK in mad-client.log"
    fi
done

ALICE_IP=$(client_ip alice)
BOB_IP=$(client_ip bob)
CAROL_IP=$(client_ip carol)
DAVE_IP=$(client_ip dave)

if [ -z "$ALICE_IP$BOB_IP$CAROL_IP$DAVE_IP" ]; then
    echo
    echo "*** Some clients failed to join. Aborting further tests. ***"
    exit 1
fi

# ---- test 1: intra-group reachability ---------------------------------
echo
echo "Test 1: intra-group reachability (should succeed)"
if docker exec madtest-alice ping -c 3 -W 2 -i 0.5 "$BOB_IP" >/dev/null 2>&1; then
    report pass "alice → bob ($BOB_IP)"
else
    report fail "alice → bob ($BOB_IP)" "ping failed"
fi
if docker exec madtest-carol ping -c 3 -W 2 -i 0.5 "$DAVE_IP" >/dev/null 2>&1; then
    report pass "carol → dave ($DAVE_IP)"
else
    report fail "carol → dave ($DAVE_IP)" "ping failed"
fi

# ---- test 2: cross-group isolation ------------------------------------
echo
echo "Test 2: cross-group isolation (should be BLOCKED)"
# A few attempts so we don't false-positive on a single dropped packet.
if docker exec madtest-alice ping -c 3 -W 2 -i 0.5 "$CAROL_IP" >/dev/null 2>&1; then
    report fail "alice (gA) → carol (gB)" "PING SUCCEEDED — packets crossing groups!"
else
    report pass "alice (gA) cannot reach carol (gB)"
fi
if docker exec madtest-dave ping -c 3 -W 2 -i 0.5 "$ALICE_IP" >/dev/null 2>&1; then
    report fail "dave (gB) → alice (gA)" "PING SUCCEEDED — packets crossing groups!"
else
    report pass "dave (gB) cannot reach alice (gA)"
fi

# ---- test 3: packet integrity (UDP, exact loss reporting) -------------
echo
echo "Test 3: packet integrity over the tunnel (UDP, 50 Mbps for 5s)"
docker exec -d madtest-bob iperf3 -s -1 -B "$BOB_IP"
sleep 1
result=$(docker exec madtest-alice iperf3 -c "$BOB_IP" -u -b 50M -t 5 -J 2>/dev/null || echo '{}')
lost=$(echo "$result" | jq -r '.end.sum.lost_packets // "?"')
total=$(echo "$result" | jq -r '.end.sum.packets // "?"')
rate=$(echo "$result" | jq -r '.end.sum.bits_per_second // 0' | awk '{printf "%.1f", $1/1e6}')
if [ "$lost" = "0" ] && [ "$total" != "?" ] && [ "$total" != "0" ]; then
    report pass "UDP integrity: $total packets sent, 0 lost, ${rate} Mbps"
else
    report fail "UDP integrity" "lost=$lost total=$total rate=${rate}Mbps"
fi

# ---- test 4: payload exact-match (md5) --------------------------------
echo
echo "Test 4: payload preservation (1 MiB random blob across tunnel)"
docker exec madtest-bob bash -c 'nc -l -p 5555 > /tmp/recv.bin & echo $! > /tmp/nc.pid' 2>/dev/null
sleep 1
docker exec madtest-alice bash -c "head -c 1048576 /dev/urandom | tee /tmp/sent.bin | nc -q 1 $BOB_IP 5555" >/dev/null 2>&1
sleep 1
sent=$(docker exec madtest-alice md5sum /tmp/sent.bin | awk '{print $1}')
recv=$(docker exec madtest-bob md5sum /tmp/recv.bin 2>/dev/null | awk '{print $1}')
if [ -n "$sent" ] && [ "$sent" = "$recv" ]; then
    report pass "1 MiB blob arrived intact (md5 $sent)"
else
    report fail "payload integrity" "sent=$sent recv=$recv"
fi
docker exec madtest-bob bash -c 'kill $(cat /tmp/nc.pid) 2>/dev/null' || true

# ---- test 5: no plaintext leak on docker bridge -----------------------
echo
echo "Test 5: docker-bridge traffic carries only encrypted SSH"
# Send a known-string ICMP payload from alice → bob (over the mad tunnel
# = encrypted SSH between containers). Capture SSH traffic on the docker
# bridge for 5 seconds; the magic string must NOT appear in plaintext.
MAGIC="MADTEST-PLAINTEXT-CANARY-7c5f8a"
> /tmp/madtest-tcpdump.log
docker exec madtest-gateway timeout 5 tcpdump -i eth0 -nn -A 'tcp and port 22' > /tmp/madtest-tcpdump.log 2>/dev/null &
TD=$!
sleep 1
# Hex pattern accepted by `ping -p`. Send several pings worth so there's
# real SSH traffic carrying the encrypted ICMP frames.
docker exec madtest-alice bash -c "ping -c 8 -i 0.5 -p $(printf '%s' "$MAGIC" | xxd -p | tr -d '\n') $BOB_IP" >/dev/null 2>&1 || true
wait $TD 2>/dev/null || true
if grep -q "$MAGIC" /tmp/madtest-tcpdump.log; then
    report fail "ssh tunnel encryption" "magic string leaked on docker bridge"
else
    report pass "no plaintext leak on docker bridge (ssh encrypts the tunnel)"
fi

# ---- bonus: max throughput (informational, not pass/fail) -------------
echo
echo "Bonus: max TCP throughput (alice → bob through gateway forwarding)"
docker exec -d madtest-bob iperf3 -s -1 -B "$BOB_IP"
sleep 1
result=$(docker exec madtest-alice iperf3 -c "$BOB_IP" -t 8 -P 4 -J 2>/dev/null || echo '{}')
sender_mbps=$(echo "$result" | jq -r '.end.sum_sent.bits_per_second // 0' | awk '{printf "%.1f", $1/1e6}')
recv_mbps=$(echo "$result" | jq -r '.end.sum_received.bits_per_second // 0' | awk '{printf "%.1f", $1/1e6}')
retrans=$(echo "$result" | jq -r '.end.sum_sent.retransmits // "?"')
echo "  alice → bob: ${sender_mbps} Mbps sender, ${recv_mbps} Mbps receiver, retransmits=${retrans}"

# ---- summary ---------------------------------------------------------
echo
echo "================================="
echo "  $PASS passed, $FAIL failed"
echo "================================="
[ $FAIL -eq 0 ]
