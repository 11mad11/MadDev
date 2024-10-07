ssh_server="${ssh_user}@${ssh_ip} -p ${ssh_port}"
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

ssh_cmd() {
    ssh -S ${control_path} ${ssh_server} $@
}

ssh_string(){
    echo "ssh -S ${control_path} ${ssh_server} $@"
}

# === Logic ===

if [ $# -eq 0 ]; then
    echo "Options: sign, tun"
    exit 1
fi

terminal_settings=$(stty -g)
restore_terminal() {
    stty $terminal_settings
}
stty -echo -icanon time 0 min 1
trap restore_terminal EXIT

#set -x
set -e

case $1 in
    update)
        ssh_cmd mad download ${key} ${ssh_ip} ${ssh_port} ${ssh_user} | tee /tmp/newmad.sh > /dev/null
        {
            sudo rm ${SCRIPT}
            sudo mv /tmp/newmad.sh ${SCRIPT}
            sudo chmod +x ${SCRIPT}
            echo "Updated!"
        }
        ;;
    sign)
        key_expended=${key/#\~/$HOME}
        echo $(ssh_cmd signsshkey < "${key_expended}.pub") > "${key_expended}-cert.pub"
        echo "Signed!"
        ;;
    ssh)
        ssh -o "ProxyCommand $(ssh_string  -W %h:%p)" ${@:2}
        ;;
    use)
        echo "Ready"
        ssh_cmd -L localhost:${3}:${2}:1 -N
        ;;
    register)
        echo "Ready"
        ssh_cmd -R ${2}:1:localhost:${3} -N
        ;;
    sshd)
        echo "Ready"
        ssh_cmd -R ${2}:22:localhost:${3:-22} -N
        ;;
    tun)
        subnet=$(ssh_cmd tun getSubnet ${2})
        sudo socat TUN:${subnet},iff-no-pi,up,tun-type=tap EXEC:\'"$(ssh_string tun open ${2})"\'
        ;;
    admin)
        ssh_cmd admin
        ;;
    help)
        ssh_cmd help
        ;;
    *)
        echo "Invalid option. See readme"
        exit 1
        ;;
esac