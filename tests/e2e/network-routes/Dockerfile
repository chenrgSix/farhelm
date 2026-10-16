FROM farhelm-agent-dev:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 python3 openssh-server && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
COPY easytier-linux-aarch64/easytier-core /usr/local/bin/easytier-core
COPY easytier-linux-aarch64/easytier-cli /usr/local/bin/easytier-cli
RUN chmod 755 /usr/local/bin/easytier-*
ENTRYPOINT ["sleep","infinity"]
COPY node-v24.14.0-linux-arm64/bin/node /usr/local/bin/node
