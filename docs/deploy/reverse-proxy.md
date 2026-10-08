# Reverse proxy and forward auth

The gateway has no login of its own. It trusts an identity header **only** from the peer addresses in `PIRC_TRUSTED_PROXIES`, so the proxy is part of the security boundary. This page lists what the proxy must do and gives nginx and Traefik examples. The [NixOS module](nixos.md) generates the nginx part.

## Routes

| Path                                             | Forward auth | Identity header                | Notes                                                                                   |
| ------------------------------------------------ | ------------ | ------------------------------ | --------------------------------------------------------------------------------------- |
| `/` (static web bundle)                          | yes          | not needed                     | Serve `apps/web/dist` (Nix: `share/pirc/web`) with a SPA fallback to `index.html`.      |
| `/api/…`, browser requests                       | yes          | **set** from the auth response | HTTP and WebSocket (`/api/events`, terminal and browser streams). Long-lived upgrades.  |
| `/api/…` with `Authorization: Bearer pirc_dev_…` | **no**       | **stripped**                   | Phone device tokens; the gateway validates them itself.                                 |
| `/node/connect`                                  | **no**       | **stripped**                   | WebSocket from nodes, authenticated by `PIRC_NODE_TOKEN`. Only needed for remote nodes. |

Rules that hold for every route:

- Always overwrite the identity header. A client-supplied `x-pirc-user` must never reach the gateway; on the device-token and node routes it must be removed. The gateway refuses a request carrying both a device token and an identity header (fail-closed), but that only protects you if the header is absent when it should be.
- When the gateway has `PIRC_PROXY_SECRET`, add `x-pirc-proxy-secret: <secret>` to every `/api/` request, browser and device-token alike (see [below](#proxy-shared-secret)).
- Pass `Host` and `Origin` through unchanged; the gateway compares them exactly against `PIRC_ALLOWED_HOSTS` and `PIRC_ALLOWED_ORIGINS`.
- Use TLS end to end from the client to the proxy. The proxy → gateway hop is plain HTTP on loopback or a private interface.
- Do not expose the gateway or the proxy on the public Internet (no Tailscale Funnel). Forward auth is a second factor for a private network, not an Internet-facing login.
- Static serving: the bundle is immutable per build. The `index.html` and `sw.js` should be served with `Cache-Control: no-cache` so upgrades are seen; hashed files under `/assets/` may be cached for long.

## Device tokens

Phones pair from the web (**Settings → Devices → Phones**) and then send `Authorization: Bearer pirc_dev_…`. For these requests the proxy must:

1. skip forward auth (otherwise the phone gets the login page),
2. strip the identity header,
3. still route to the same gateway, which checks the token's hash, the trusted peer and `Host`.

Device tokens cannot reach `/api/devices*`, `/api/providers*` or `/api/provider-auth/*`; everything else acts as the paired user. Expiry is `PIRC_DEVICE_TOKEN_IDLE_DAYS` / `PIRC_DEVICE_TOKEN_MAX_DAYS` on the gateway.

## nginx (Authelia `auth_request`)

The NixOS module generates the equivalent of this; adapt paths and the auth endpoint.

```nginx
server {
  listen 443 ssl http2;
  server_name pirc.example.ts.net;
  # ssl_certificate …; ssl_certificate_key …;

  root /srv/pirc/web;

  location = /_pirc_auth {
    internal;
    # Device tokens: no identity, the gateway checks the token.
    if ($http_authorization ~* "^bearer\s+pirc_dev_") { return 200; }
    proxy_pass http://127.0.0.1:9091/api/authz/auth-request;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
    proxy_set_header X-Original-Method $request_method;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /api/ {
    auth_request /_pirc_auth;
    auth_request_set $pirc_user $upstream_http_remote_user;   # Authelia's Remote-User
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header x-pirc-user $pirc_user;                  # empty for device tokens
    proxy_set_header Host $http_host;
    proxy_set_header Origin $http_origin;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;
  }

  # Remote nodes only.
  location = /node/connect {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header x-pirc-user "";
    proxy_read_timeout 1h;
  }

  location / {
    auth_request /_pirc_auth;
    try_files $uri $uri/ /index.html;
  }
}
```

`proxy_set_header x-pirc-user $pirc_user` with an empty variable removes the header, which is what the device-token branch relies on.

## Proxy shared secret

The trusted-proxy check is by peer address only, so on a shared host any local process connecting from `127.0.0.1` looks like the proxy. Set `PIRC_PROXY_SECRET` on the gateway (≥ 32 random characters, e.g. `openssl rand -base64 36`) and have the proxy prove itself with it on every `/api/` request; the gateway then refuses trusted-address requests without the matching `x-pirc-proxy-secret` header. Without it the gateway logs a warning at startup.

nginx: keep the header in a file readable only by root and the nginx account, outside any world-readable config or the Nix store, and include it in `location /api/`:

```nginx
# /etc/nginx/pirc-proxy-secret.conf (mode 0640, owner root, group nginx)
proxy_set_header X-Pirc-Proxy-Secret "<secret>";
```

```nginx
  location /api/ {
    # … as above …
    include /etc/nginx/pirc-proxy-secret.conf;
  }

  location = /node/connect {
    # … as above …
    proxy_set_header X-Pirc-Proxy-Secret "";
  }
```

Traefik: add a `headers` middleware with `customRequestHeaders: { X-Pirc-Proxy-Secret: '<secret>' }` to both `pirc-api` and `pirc-device`, defined in a file-provider file that only Traefik can read (not in container labels or a world-readable file).

The [NixOS module](nixos.md) does this for its nginx virtual host: it generates the secret at first start into the gateway's state directory and writes the nginx snippet to `/run/pirc-nginx` (root and the nginx group only); nothing reaches the Nix store.

Even with the secret, a node on the gateway host should run its agents network-sandboxed: they must not be able to talk to the gateway port at all.

## Traefik (Authelia forward-auth middleware)

Three routers on the same host, ordered by priority:

```yaml
http:
  routers:
    pirc-node: # remote nodes; no auth middleware, identity header removed
      rule: Host(`pirc.example.ts.net`) && Path(`/node/connect`)
      priority: 300
      service: pirc-gateway
      middlewares: [pirc-strip-identity]
    pirc-device: # phones; no auth middleware, identity header removed
      rule: Host(`pirc.example.ts.net`) && PathPrefix(`/api/`) && HeaderRegexp(`Authorization`, `^Bearer pirc_dev_`)
      priority: 200
      service: pirc-gateway
      middlewares: [pirc-strip-identity]
    pirc-api: # browsers
      rule: Host(`pirc.example.ts.net`) && PathPrefix(`/api/`)
      priority: 100
      service: pirc-gateway
      middlewares: [authelia]
    pirc-web:
      rule: Host(`pirc.example.ts.net`)
      priority: 50
      service: pirc-web
      middlewares: [authelia]
  middlewares:
    authelia:
      forwardAuth:
        address: http://127.0.0.1:9091/api/authz/forward-auth
        trustForwardHeader: true
        authResponseHeaders: [Remote-User]
    pirc-strip-identity:
      headers:
        customRequestHeaders:
          X-Pirc-User: '' # an empty value removes the header
  services:
    pirc-gateway:
      loadBalancer:
        servers: [{ url: 'http://127.0.0.1:8787' }]
    pirc-web:
      loadBalancer:
        servers: [{ url: 'http://127.0.0.1:18788' }] # any static file server
```

- Authelia's `Remote-User` must be renamed to the gateway's identity header (`X-Pirc-User` by default). With Traefik that is a second `headers` middleware on `pirc-api`, or configure Authelia to emit the header name you set in `PIRC_IDENTITY_HEADER`.
- On Traefik v2 the matcher is `HeadersRegexp`.
- Serve the web bundle from any static server (nginx, Caddy, `python3 -m http.server` in a pinch); it is plain files.

## Verifying

Run these from a machine that goes through the proxy; replace the host.

```sh
H=https://pirc.example.ts.net

# 1. Browser path without a session cookie: the auth login redirect, not gateway JSON.
curl -s -o /dev/null -w '%{http_code}\n' $H/api/sessions

# 2. Forged identity header from outside: must NOT be accepted (redirect or 401/403; never 200).
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-pirc-user: alice@example.com' $H/api/sessions

# 2b. On the gateway host, with PIRC_PROXY_SECRET set: a direct request without the secret is refused (401).
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: pirc.example.ts.net' -H 'x-pirc-user: alice@example.com' http://127.0.0.1:8787/api/sessions

# 3. A fake device token reaches the gateway (JSON error with code "unauthenticated"), not the login page.
curl -s -H 'Authorization: Bearer pirc_dev_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' $H/api/sessions

# 4. A real device token works and is scoped: sessions 200, providers 403.
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" $H/api/sessions
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" $H/api/providers

# 5. A node without a token is refused with a WebSocket close, not an auth redirect.
curl -s -o /dev/null -w '%{http_code}\n' -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGVzdA==' $H/node/connect
```

Then log in through the browser and confirm `GET /api/nodes` lists every node.
