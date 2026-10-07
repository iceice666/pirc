#!/usr/bin/env python3
"""ssh ProxyCommand for agents inside pirc's sandbox (srt).

srt routes ssh through its SOCKS5 proxy with `nc -X 5`, but the proxy wants
the per-session username and password that srt puts in `$ALL_PROXY`, and
BSD nc (macOS) cannot send them. This makes the same hop with them; the
proxy still applies the sandbox's domain allowlist to the destination.

    ssh -o ProxyCommand='python3 /path/to/sandbox-ssh-proxy.py %h %p' ...

See docs/deploy/sandbox-and-browser.md ("Git and the GitHub CLI").
"""
import os
import select
import socket
import sys
import urllib.parse


def fail(message):
    sys.stderr.write(f"sandbox-ssh-proxy: {message}\n")
    raise SystemExit(1)


def recv_exact(sock, size):
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            fail("the sandbox proxy closed the connection")
        data += chunk
    return data


def main():
    if len(sys.argv) != 3:
        fail("usage: sandbox-ssh-proxy.py HOST PORT")
    host, port = sys.argv[1], int(sys.argv[2])
    proxy = os.environ.get("ALL_PROXY") or os.environ.get("all_proxy")
    if not proxy:
        fail("ALL_PROXY is not set: this only works inside the agent sandbox")
    url = urllib.parse.urlparse(proxy)
    user = urllib.parse.unquote(url.username or "").encode()
    password = urllib.parse.unquote(url.password or "").encode()
    if not url.hostname or not url.port:
        fail("ALL_PROXY has no host and port")
    if len(user) > 255 or len(password) > 255 or len(host.encode()) > 255:
        fail("credentials or host name too long for SOCKS5")

    sock = socket.create_connection((url.hostname, url.port), timeout=30)
    # Greeting: SOCKS5, offering username/password (RFC 1929) only when we have one.
    method = 2 if user else 0
    sock.sendall(bytes([5, 1, method]))
    if recv_exact(sock, 2) != bytes([5, method]):
        fail("the sandbox proxy refused the authentication method")
    if user:
        sock.sendall(bytes([1, len(user)]) + user + bytes([len(password)]) + password)
        if recv_exact(sock, 2)[1] != 0:
            fail("the sandbox proxy rejected its credentials")

    # CONNECT by name: the proxy resolves it and checks the allowlist.
    name = host.encode()
    sock.sendall(bytes([5, 1, 0, 3, len(name)]) + name + port.to_bytes(2, "big"))
    reply = recv_exact(sock, 4)
    if reply[1] != 0:
        fail(f"connection to {host}:{port} refused (SOCKS reply {reply[1]}; not an allowed domain?)")
    if reply[3] == 1:
        recv_exact(sock, 4)
    elif reply[3] == 3:
        recv_exact(sock, recv_exact(sock, 1)[0])
    elif reply[3] == 4:
        recv_exact(sock, 16)
    recv_exact(sock, 2)
    sock.settimeout(None)

    stdin, stdout = sys.stdin.fileno(), sys.stdout.fileno()
    sources = [sock, stdin]
    while True:
        readable, _, _ = select.select(sources, [], [])
        if sock in readable:
            data = sock.recv(65536)
            if not data:
                return
            os.write(stdout, data)
        if stdin in readable:
            data = os.read(stdin, 65536)
            if data:
                sock.sendall(data)
            else:
                # ssh closed its side: pass that on, keep relaying the remote.
                sock.shutdown(socket.SHUT_WR)
                sources = [sock]


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    except OSError as error:
        fail(str(error))
