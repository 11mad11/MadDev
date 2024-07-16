#!/usr/bin/env bash

# === Config ===

ssh_server=
ssh_user=
ssh_ip=
ssh_port=
key=

control_path="${HOME}/.ssh/control-${ssh_user}@${ssh_ip}:${ssh_port}"
SCRIPT=$(realpath "$0")

# === SSH Connection ===

# Function to check if the control master connection is alive
check_connection() {
    if [ -S "${control_path}" ]; then
        ssh -o ControlPath=${control_path} -O check ${ssh_server} 2>/dev/null
        return $?
    else
        return 1
    fi
}

# Check if the connection is alive
check_connection
if [ $? -ne 0 ]; then
    echo "Starting new SSH master connection..."

    ssh -M -S ${control_path} -o ControlPersist=10m ${ssh_server} -fN

    if [ $? -ne 0 ]; then
        echo "Failed to start SSH master connection. Please check your credentials."
        exit 1
    fi
else
    echo "SSH master connection is already running."
fi

# === Logic ===

if [ $# -eq 0 ]; then
    echo "Options: sign, tun"
    exit 1
fi

#set -x
set -e

case $1 in
    update)
        ssh -S ${control_path} ${ssh_server} mad download ${key} ${ssh_ip} ${ssh_port} ${ssh_user} | tee /tmp/newmad.sh > /dev/null
        {
            rm ${SCRIPT}
            mv /tmp/newmad.sh ${SCRIPT}
            chmod +x ${SCRIPT}
            echo "Updated!"
        }
        ;;
    sign)
        echo $(ssh -S ${control_path} ${ssh_server} signsshkey < "${key}.pub") > "${key}-cert.pub"
        echo "Signed!"
        ;;
    ssh)
        ssh -o "ProxyCommand ssh -S ${control_path} -W %h:%p ${ssh_server}" ${@:2}
        ;;
    use)
        echo "Ready"
        ssh -S ${control_path} ${ssh_server} -L localhost:${3}:${2}:1 -N
        ;;
    register)
        echo "Ready"
        ssh -S ${control_path} ${ssh_server} -R ${2}:1:localhost:${3} -N
        ;;
    sshd)
        echo "Ready"
        ssh -S ${control_path} ${ssh_server} -R ${2}:22:localhost:${3:-22} -N
        ;;
    tun)
        subnet=$(ssh -S ${control_path} ${ssh_server} tun getSubnet ${2})
        sudo socat TUN:${subnet},iff-no-pi,up,tun-type=tap EXEC:\'"ssh -S ${control_path} ${ssh_server} tun open ${2}"\'
        ;;
    *)
        echo "Invalid option. Usage: $0 {sign|tun}"
        exit 1
        ;;
esac