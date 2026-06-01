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
# (or "MAD_TUN_OK tap-XX-N (bridged) peer=<our_ip>/24 …" for L2).
client_ip() {
    docker exec "madtest-$1" sh -c "grep -oE 'peer=[0-9.]+/' /var/log/mad-client.log | head -1 | sed 's|peer=||;s|/||'" 2>/dev/null
}

client_mode() {
    docker exec "madtest-$1" sh -c "grep -oE 'mode=l[23]' /var/log/mad-client.log | head -1 | sed 's|mode=||'" 2>/dev/null
}

# ---- test 0: every client joined --------------------------------------
echo "Test 0: all clients joined the mad network"
for u in alice bob eve frank carol dave; do
    ip=$(client_ip "$u")
    mode=$(client_mode "$u")
    if [ -n "$ip" ]; then
        report pass "$u joined ($ip, $mode)"
    else
        report fail "$u joined" "no MAD_TUN_OK in mad-client.log"
    fi
done

ALICE_IP=$(client_ip alice)
BOB_IP=$(client_ip bob)
EVE_IP=$(client_ip eve)
FRANK_IP=$(client_ip frank)
CAROL_IP=$(client_ip carol)
DAVE_IP=$(client_ip dave)

if [ -z "$ALICE_IP$BOB_IP$EVE_IP$FRANK_IP$CAROL_IP$DAVE_IP" ]; then
    echo
    echo "*** Some clients failed to join. Aborting further tests. ***"
    exit 1
fi

# ---- test 1: intra-group reachability ---------------------------------
echo
echo "Test 1: intra-group reachability (should succeed)"
if docker exec madtest-alice ping -c 3 -W 2 -i 0.5 "$BOB_IP" >/dev/null 2>&1; then
    report pass "alice (L3) → bob (L3): $BOB_IP"
else
    report fail "alice → bob ($BOB_IP)" "ping failed"
fi
if docker exec madtest-carol ping -c 3 -W 2 -i 0.5 "$DAVE_IP" >/dev/null 2>&1; then
    report pass "carol (L3) → dave (L3): $DAVE_IP"
else
    report fail "carol → dave ($DAVE_IP)" "ping failed"
fi
if docker exec madtest-eve ping -c 3 -W 2 -i 0.5 "$FRANK_IP" >/dev/null 2>&1; then
    report pass "eve (L2) → frank (L2): $FRANK_IP"
else
    report fail "eve → frank ($FRANK_IP)" "ping failed"
fi
# L2 ↔ L3 within the same group: alice's gateway tun is /32-peered,
# eve's gateway tap is bridged into mad-ga. Cross only works because
# the gateway IP-forwards between the /32 tun and the bridge subnet.
if docker exec madtest-alice ping -c 3 -W 2 -i 0.5 "$EVE_IP" >/dev/null 2>&1; then
    report pass "alice (L3) → eve (L2): $EVE_IP (mixed-mode)"
else
    report fail "alice → eve ($EVE_IP)" "ping failed"
fi
if docker exec madtest-eve ping -c 3 -W 2 -i 0.5 "$ALICE_IP" >/dev/null 2>&1; then
    report pass "eve (L2) → alice (L3): $ALICE_IP (mixed-mode)"
else
    report fail "eve → alice ($ALICE_IP)" "ping failed"
fi

# ---- test 2: cross-group isolation ------------------------------------
echo
echo "Test 2: cross-group isolation (should be BLOCKED)"
for src_dst in "alice:$CAROL_IP" "dave:$ALICE_IP" "eve:$CAROL_IP" "eve:$DAVE_IP"; do
    src="${src_dst%%:*}"; dst="${src_dst#*:}"
    if docker exec "madtest-$src" ping -c 3 -W 2 -i 0.5 "$dst" >/dev/null 2>&1; then
        report fail "$src → $dst" "PING SUCCEEDED — packets crossing groups!"
    else
        report pass "$src cannot reach $dst (across group)"
    fi
done

# ---- test 3: L2 broadcast / ARP isolation -----------------------------
echo
echo "Test 3: L2 broadcast scope"
# Capture ARP-who-has frames on frank's tap0 for 4s. eve sends a
# burst of ARP requests by pinging a non-existent IP in the /24.
docker exec -d madtest-frank bash -c 'timeout 4 tcpdump -i tap0 -nn -c 4 arp > /tmp/arp-frank.log 2>&1'
docker exec -d madtest-dave  bash -c 'timeout 4 tcpdump -i tap0 -nn -c 4 arp > /tmp/arp-dave.log 2>&1 || true'
sleep 1
docker exec madtest-eve ping -c 4 -W 1 -i 0.3 "10.77.10.222" >/dev/null 2>&1 || true
sleep 4
# `grep -c` exits non-zero on zero matches; without -e we'd run the
# `|| echo 0` fallback AND the grep itself would have already written
# "0\n", giving "0\n0". Force a clean numeric output via wc -l.
frank_arp=$(docker exec madtest-frank sh -c 'grep "who-has 10.77.10.222" /tmp/arp-frank.log 2>/dev/null | wc -l')
dave_arp=$(docker exec madtest-dave  sh -c 'grep "who-has 10.77.10.222" /tmp/arp-dave.log 2>/dev/null | wc -l')
# We expect frank (same group, L2) to see ≥1 of eve's ARPs.
if [ "$frank_arp" -ge 1 ]; then
    report pass "eve's ARP-who-has reaches frank (intra-group L2 broadcast)"
else
    report fail "eve's ARP reaches frank" "frank saw 0 ARP frames on tap0"
fi
# dave (different group) must NOT see eve's ARP. dave is L3 so his
# tap0 doesn't exist anyway, but we count to be sure.
if [ "$dave_arp" = "0" ]; then
    report pass "eve's ARP-who-has does NOT cross to dave (gB)"
else
    report fail "ARP isolation" "dave saw $dave_arp ARP frames from gA"
fi

# ---- test 4: packet integrity (UDP, exact loss reporting) -------------
echo
echo "Test 4: packet integrity over the tunnel (UDP, 50 Mbps for 5s)"
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

# ---- test 5: payload exact-match (md5) --------------------------------
echo
echo "Test 5: payload preservation (1 MiB random blob across tunnel)"
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

# ---- test 6: no plaintext leak on docker bridge -----------------------
echo
echo "Test 6: docker-bridge traffic carries only encrypted SSH"
MAGIC="MADTEST-PLAINTEXT-CANARY-7c5f8a"
> /tmp/madtest-tcpdump.log
docker exec madtest-gateway timeout 5 tcpdump -i eth0 -nn -A 'tcp and port 22' > /tmp/madtest-tcpdump.log 2>/dev/null &
TD=$!
sleep 1
docker exec madtest-alice bash -c "ping -c 8 -i 0.5 -p $(printf '%s' "$MAGIC" | xxd -p | tr -d '\n') $BOB_IP" >/dev/null 2>&1 || true
wait $TD 2>/dev/null || true
if grep -q "$MAGIC" /tmp/madtest-tcpdump.log; then
    report fail "ssh tunnel encryption" "magic string leaked on docker bridge"
else
    report pass "no plaintext leak on docker bridge (ssh encrypts the tunnel)"
fi

# ---- test 7: ssh -R registers a Unix socket with correct group --------
# alice publishes a TCP service on her localhost:8888 via `ssh -R`.
# The gateway-side sshd binds /run/mad/groups/ga/web.sock with
# StreamLocalBindMask 0117 → mode 0660, gid inherited from the
# 2770-setgid dir = ga.
echo
echo "Test 7: ssh -R service registration (socket mode + gid)"
# clean any leftover
docker exec madtest-gateway rm -f /run/mad/groups/ga/web.sock 2>/dev/null || true
docker exec -d madtest-alice bash -c '
  while true; do echo "CANARY-ALICE-WEB" | nc -l -p 8888 -q 1; done
'
sleep 1
docker exec -d madtest-alice bash -c '
  exec ssh -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes \
    -i /init-keys/alice \
    -R /run/mad/groups/ga/web.sock:localhost:8888 \
    alice@gateway service hold ga/web
' 2>/dev/null
# wait for the socket to appear
for i in $(seq 1 15); do
    if docker exec madtest-gateway test -S /run/mad/groups/ga/web.sock; then break; fi
    sleep 1
done
if docker exec madtest-gateway test -S /run/mad/groups/ga/web.sock; then
    perms=$(docker exec madtest-gateway stat -c "%a %G" /run/mad/groups/ga/web.sock)
    if [ "$perms" = "660 ga" ]; then
        report pass "ssh -R bound /run/mad/groups/ga/web.sock with mode 660 group=ga"
    else
        report fail "socket perms" "got '$perms', expected '660 ga'"
    fi
else
    report fail "socket appears" "ssh -R never bound the socket within 15s"
fi

# ---- test 8: ssh -L through the socket actually carries traffic -------
echo
echo "Test 8: ssh -L through the registered socket (same-group consumer)"
# bob forwards a local TCP port to alice's Unix socket via the gateway.
# We pull a few bytes via nc and verify the canary.
docker exec -d madtest-bob bash -c '
  exec ssh -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes \
    -i /init-keys/bob \
    -L 127.0.0.1:9000:/run/mad/groups/ga/web.sock \
    bob@gateway service ping ga/web
' 2>/dev/null
sleep 2
got=$(docker exec madtest-bob bash -c 'echo "" | nc -w 2 127.0.0.1 9000 2>/dev/null' | head -c 17)
if [ "$got" = "CANARY-ALICE-WEB" ]; then
    report pass "bob (gA) read alice's canary through ssh -L → ssh -R chain"
else
    report fail "service forwarding flow" "got '$got' (expected CANARY-ALICE-WEB)"
fi

# ---- test 9: cross-group ssh -L is blocked at the socket -------------
echo
echo "Test 9: cross-group ssh -L blocked by 2770 group dir"
# carol (gB) tries to forward through ga's web.sock. sshd should
# refuse because /run/mad/groups/ga/ is mode 2770 with group=ga.
out=$(docker exec madtest-carol bash -c '
  ssh -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes \
    -i /init-keys/carol -o ConnectTimeout=5 \
    -L 127.0.0.1:9001:/run/mad/groups/ga/web.sock \
    carol@gateway service ping ga/web 2>&1 &
  CAROL_PID=$!
  sleep 3
  got=$(echo "" | nc -w 2 127.0.0.1 9001 2>/dev/null)
  kill $CAROL_PID 2>/dev/null
  printf "%s" "$got"
')
if [ -z "$out" ] || [ "$out" != "CANARY-ALICE-WEB" ]; then
    report pass "carol (gB) cannot read alice's gA socket via ssh -L (got: '${out:-empty}')"
else
    report fail "cross-group socket isolation" "carol got alice's canary"
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

# ---- cleanup the service-forwarding helpers ---------------------------
docker exec madtest-alice bash -c 'pkill -f "ssh.*service hold" 2>/dev/null; pkill nc 2>/dev/null' >/dev/null 2>&1 || true
docker exec madtest-bob bash -c 'pkill -f "ssh.*service ping" 2>/dev/null'                 >/dev/null 2>&1 || true
docker exec madtest-carol bash -c 'pkill -f "ssh.*service ping" 2>/dev/null'               >/dev/null 2>&1 || true

# ---- summary ---------------------------------------------------------
echo
echo "================================="
echo "  $PASS passed, $FAIL failed"
echo "================================="
[ $FAIL -eq 0 ]
