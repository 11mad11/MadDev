#!/bin/bash
set -e
trap cleanup SIGINT SIGTERM

iface_name="${1}"
ip_address="${2}"
netmask="${3}"

cleanup() {
    echo "Cleaning up..."

    # Take down bridge if exists
    if ip link show "$iface_name" &> /dev/null; then
        echo "Taking down bridge $iface_name..."
        ip link set name $iface_name down
        ip link del $iface_name
        echo "Bridge $iface_name taken down."
    fi

    echo "Cleanup complete."
}

setup_interface() {

    # Check if the bridge already exists
    if ip link show "$iface_name" &> /dev/null
    then
        echo "Bridge $iface_name already exists. Taking it down..."
        cleanup
    fi

    echo "Creating and setting up bridge $iface_name..."
    ip link add name $iface_name type bridge
    ip link set dev $iface_name up
    echo "Bridge $iface_name created and activated."

    # Assign the IP address and netmask to the bridge
    ip addr add $ip_address/$netmask dev $iface_name
    echo "Assigned IP address $ip_address/$netmask to $iface_name."
}

setup_interface

while true; do
    sleep 3600  # Sleep for 1 hour (3600 seconds)
done