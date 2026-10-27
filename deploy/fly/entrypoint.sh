#!/bin/sh
# Fly mounts the volume owned by root; hand it to the unprivileged `node` user,
# then run the command as that user. Secrets arrive as environment variables.
set -eu
mkdir -p /data
chown -R node:node /data
chmod 0700 /data
umask 077
exec setpriv --reuid=node --regid=node --init-groups "$@"
