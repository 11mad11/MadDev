# === Config ===

CONFIG_FILE="${HOME}/.mad/configuration.cfg"

if [ "$1" == "config" ]; then
    CONFIG_DIR=$(dirname "$CONFIG_FILE")
    mkdir -p "$CONFIG_DIR"

    ssh none@${2} -p ${3:-22} mad config ${2} ${3-22} | tee >(sed -n $'/\f/,$p' | sed '1d' > $CONFIG_FILE)
    exit 0
fi

if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
else
    echo "Configuration file not found: $CONFIG_FILE"
    exit 1
fi