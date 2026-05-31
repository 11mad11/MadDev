FROM ubuntu:24.04

# Test client image: ssh out to the real production hub, drive a tap via
# socat, run a mesh-style TCP+UDP+broadcast workload.
#
# Tools we need:
#   - openssh-client    : ssh to the hub
#   - iproute2          : ip tuntap / link / addr
#   - iputils-ping      : ping
#   - iputils-arping    : verifies L2 ARP broadcast crosses
#   - iperf3            : multi-port TCP+UDP load
#   - tcpdump           : capture frames
#   - socat             : the userspace tap proxy (server side runs in mad daemon)
#   - python3           : summary parser
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-client iproute2 iputils-ping iputils-arping \
        iperf3 tcpdump socat dnsutils net-tools python3 ca-certificates \
        curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Bun for compiling the mad source.
RUN curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun

WORKDIR /opt/mad
COPY package.json bun.lock ./
RUN bun install --production

COPY src ./src
COPY tsconfig.json ./

# Compile the mad binary inside the image.
RUN bun build --compile ./src/cli.ts --outfile=/usr/bin/mad

COPY tests/stress/entrypoint-client.sh /usr/local/bin/entrypoint-client.sh
RUN chmod +x /usr/local/bin/entrypoint-client.sh

WORKDIR /work
CMD ["sleep", "infinity"]
