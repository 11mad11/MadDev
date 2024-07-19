#!/bin/bash
set -e

iface_name="${1}"
namespace="${2}"
#subnet="${3}"

trap cleanup SIGINT SIGTERM

if [ ! -f "/run/netns/${namespace}" ]; then
    echo "Creating namesapce..."
    ip netns add ${namespace}
fi

cleanup() {
    echo "Cleaning up..."

    if [ -f "/run/netns/${namespace}" ]; then
        echo "Deleting namesapce..."
        ip netns delete ${namespace}
    fi

    echo "Cleanup complete."
}

setup_interface() {

    # Check if the bridge already exists
    if ip netns exec ${namespace} ip link show "$iface_name" &> /dev/null
    then
        echo "Bridge $iface_name already exists. Taking it down..."
        cleanup
    fi

    echo "Creating and setting up bridge $iface_name..."
    ip netns exec ${namespace} ip link add name $iface_name type bridge
    ip netns exec ${namespace} ip link set dev $iface_name up
    echo "Bridge $iface_name created and activated."

    # Assign the IP address and netmask to the bridge
    #ip netns exec ${namespace} ip addr add $subnet dev $iface_name
    #echo "Assigned IP address $subnet to $iface_name."
}

setup_interface

while true; do
    sleep 3600  # Sleep for 1 hour (3600 seconds)
done