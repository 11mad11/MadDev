#!/bin/bash

# line number where payload starts
PAYLOAD_LINE=$(awk '/^__PAYLOAD_BEGINS__/ { print NR + 1; exit 0; }' $0)
RUN_SETUP=true
INSTALL_PATH=/usr/bin/mad

while getopts ":np:" opt; do
    case $opt in
    n)
        # prevent entering setup
        RUN_SETUP=false
        ;;
    p)
        INSTALL_PATH=$OPTARG
        ;;
    \?)
        echo "Invalid option: -$OPTARG" >&2
        exit 1
        ;;
    :)
        echo "Option -$OPTARG requires an argument." >&2
        exit 1
        ;;
    esac
done

rm $INSTALL_PATH

# extract the embedded binary executable and save it to the specified location
tail -n +${PAYLOAD_LINE} "$0" | base64 -d >"$INSTALL_PATH"
chmod +x "$INSTALL_PATH"

# run the executable
if [ "$RUN_SETUP" = "true" ]; then
    "$INSTALL_PATH" setup
fi

exit 0
__PAYLOAD_BEGINS__
