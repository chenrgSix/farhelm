FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server bash \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash terminal \
    && passwd -d terminal \
    && mkdir -p /run/sshd
# Test-only fixture, bound to host loopback by the harness. No Agent is installed.
CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/fixture/sshd_config"]
