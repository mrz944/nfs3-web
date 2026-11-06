# Public hosting at nfs3.xyz

Cloudflare terminates public HTTPS on port 443 and forwards requests through
`cloudflared` to the game at `http://127.0.0.1:8080`. The game server does not
listen on local port 443. The same tunnel carries game downloads and the `/net`
WebSocket relay.

## Authorize the domain

1. Add `nfs3.xyz` to your Cloudflare account as a website/zone. Review imported
   DNS records so existing services, including email, are preserved.
2. At your domain registrar, replace the current nameservers with the exact
   two nameservers assigned by Cloudflare. Wait for the zone to become active.
3. From the repository root, authenticate and select `nfs3.xyz`:

   ```sh
   build/bin/cloudflared tunnel login
   ```

The client is downloaded locally into the git-ignored `build/bin/` directory.
The login certificate is stored in `~/.cloudflared/`. Do not commit certificates
or tunnel credentials.

## Create and configure the tunnel

Run these commands once, after authorization:

```sh
mkdir -p build/cloudflare
build/bin/cloudflared tunnel create --credentials-file build/cloudflare/credentials.json nfs3-web
cp deploy/cloudflared.yml.example build/cloudflare/config.yml
```

In `build/cloudflare/config.yml`, replace `TUNNEL_UUID` with the UUID reported
by the create command, and set `credentials-file` to the absolute path of
`build/cloudflare/credentials.json`.

Validate the configuration, then add the DNS route:

```sh
build/bin/cloudflared tunnel --config build/cloudflare/config.yml ingress validate
build/bin/cloudflared tunnel route dns nfs3-web nfs3.xyz
```

If the apex already has an A, AAAA or CNAME record, review and replace only
the web record that conflicts with this route. Preserve unrelated DNS records.

## Run

Keep these two processes running, in separate terminals or managed services:

```sh
node web/serve.mjs 8080 --game game
build/bin/cloudflared tunnel --config build/cloudflare/config.yml run
```

Visit `https://nfs3.xyz/`. Players download the game automatically. Their
browser storage is specific to this domain, so switching from the old
Tailscale URL requires another initial download.

Check that `/`, `/dist/nfs3.wasm`, and `/__dev/game/nfs3.exe` return HTTP 200
and preserve the server's COOP/COEP headers. Verify `/net` connects in the
browser before testing multiplayer.

Official instructions: [Create a locally managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/).

## Services on this host

The deployed tunnel is `nfs3-web` (UUID `2c13c682-df56-4834-8e37-8eced7a39e88`).
Its live config and credentials are in the git-ignored `build/cloudflare/`
directory. Keep that directory when cleaning build outputs.

Both user services are enabled; user lingering is already enabled on this host,
so they start at boot and keep running after logout:

```sh
systemctl --user status nfs3-web nfs3-cloudflare
systemctl --user restart nfs3-web nfs3-cloudflare
journalctl --user -u nfs3-cloudflare -f
```

If OpenSnitch filtering is re-enabled, allow the executable
`/home/cyberdev/DEV/nfs3-webgl/build/bin/cloudflared`. An existing denial for
this path prevented both DNS resolution and tunnel authentication during setup.
