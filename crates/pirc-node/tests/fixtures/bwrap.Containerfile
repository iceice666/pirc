# The rootless podman cases of tests/sandbox_linux_uid0.rs: Ubuntu (the CI
# runner's release, so the test binaries' glibc matches) with bubblewrap.
FROM docker.io/library/ubuntu:24.04
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap util-linux \
    && rm -rf /var/lib/apt/lists/*
