FROM docker:27.5.1-cli AS cli
FROM farhelm-network-test:local
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
