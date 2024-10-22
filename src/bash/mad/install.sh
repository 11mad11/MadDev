# Function to read user input with a prompt
read_input() {
    local prompt="$1"
    local input
    read -p "$prompt" input
    echo "$input"
}

# Welcome message
echo "Welcome to the Setup!"
echo "Please provide the following information to establish an SSH connection."

# Get IP address from user
ip_address=$(read_input "1. Enter the IP address of the remote server (e.g., 192.168.1.1): ")

# Get port number from user, default to 22 if not provided
port_number=$(read_input "2. Enter the port number (default is 22): ")
port_number=${port_number:-22}  # Use default port if no input

# Display the gathered information
echo ""
echo "You have entered the following information:"
echo "-------------------------------------------"
echo "IP Address: $ip_address"
echo "Port Number: $port_number"
echo "-------------------------------------------"
echo "Connecting to $ip_address on port $port_number..."

# Optionally, you can connect using SSH
# Uncomment the following line to enable connection
# ssh -p "$port_number" "$ip_address"

ssh -p "$port_number" none@"$ip_address" mad download | sudo tee /usr/bin/mad > /dev/null
sudo chmod +x /usr/bin/mad
mad config "$ip_address" "$port_number"