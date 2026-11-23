#!/bin/sh
# Staging site for the online-lobby branch: staging.nfs3.xyz, port 8098, its own data, kept out
# of search engines, open or closed with a password. Run from the staging worktree (~/DEV/nfs3-webgl-staging); see
# docs/web-lobby-plan.md, section 8. Each part is started by hand:
#
#   tools/staging.sh setup         once: copies of the live game build and mods, the same game
#                                  files source (R2), links to gen/ and game/ (read only), the
#                                  TURN key
#   tools/staging.sh tunnel-setup  once: the Cloudflare tunnel "nfs3-staging" and the DNS name
#   tools/staging.sh server        the staging server, open to anyone with the address (Ctrl+C stops it)
#   tools/staging.sh server --password   the same, closed with a password page
#   tools/staging.sh tunnel        the tunnel to it (Ctrl+C stops it)
#   tools/staging.sh password      the testers' password
#
# The live site is never touched: its tunnel, port 8080, web/dist and build/ stay as they are.
set -e
cd "$(dirname "$0")/.."
here=$(pwd)
main=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)    # the main checkout (nfs3.xyz)
[ "$here" != "$main" ] || { echo "run this from the staging worktree, not the live checkout"; exit 1; }
PORT=8098
HOST=staging.nfs3.xyz
NAME=nfs3-staging
cf="$main/build/bin/cloudflared"

case "$1" in
setup)
  # reflink copies (btrfs: no extra space until they change); never links, so a staging build
  # can't write into the live files
  for d in web/dist web/mods; do [ -e "$d" ] || cp -a --reflink=auto "$main/$d" "$d"; done
  # the same game files as nfs3.xyz, from R2 (its CORS rule allows staging.nfs3.xyz: docs/r2.md)
  cp "$main/web/game-source.json" web/game-source.json
  [ -e gen ] || ln -s "$main/gen" gen
  [ -e game ] || ln -s "$main/game" game
  mkdir -p build/cloudflare
  [ -e build/cloudflare/turn.json ] || { [ -e "$main/build/cloudflare/turn.json" ] && install -m 600 "$main/build/cloudflare/turn.json" build/cloudflare/turn.json; } || true
  echo "staging ready in $here (game files: $(cat web/game-source.json))"
  ;;
tunnel-setup)
  mkdir -p build/cloudflare
  if [ ! -e build/cloudflare/credentials.json ]; then
    "$cf" tunnel create --cred-file build/cloudflare/credentials.json "$NAME"
    chmod 600 build/cloudflare/credentials.json
  fi
  id=$(sed -n 's/.*"TunnelID": *"\([^"]*\)".*/\1/p' build/cloudflare/credentials.json)
  cat > build/cloudflare/config.yml <<EOF
tunnel: $id
credentials-file: $here/build/cloudflare/credentials.json

ingress:
  - hostname: $HOST
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF
  "$cf" tunnel route dns "$NAME" "$HOST"
  echo "tunnel $NAME ($id) -> $HOST -> 127.0.0.1:$PORT"
  ;;
server)
  if [ "$2" = "--password" ]; then exec node web/serve.mjs "$PORT" --staging; fi
  exec node web/serve.mjs "$PORT" --staging --open
  ;;
tunnel)
  exec "$cf" tunnel --no-autoupdate --config build/cloudflare/config.yml run
  ;;
password)
  cat build/staging-password 2>/dev/null || echo "start the server once: it makes build/staging-password"
  ;;
*)
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
  ;;
esac
