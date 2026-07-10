# syntax=docker/dockerfile:1.7

# finch agent — container image.
#
# The agent keeps everything (cli.json login, per-service credentials, and the
# default finch.yml) under $HOME/.finch, so the container sets HOME=/data and
# you persist ONE volume. finch.yml is also read from the cwd (/data) first,
# so mounting your own manifest at /data/finch.yml works too.
#
#   docker build -t finch-agent ./agent
#   docker run -v finch-data:/data finch-agent login --hub https://finchmcp.com <token>
#   docker run -v finch-data:/data finch-agent add hello --service http://host.docker.internal:8000
#   docker run -d -v finch-data:/data finch-agent          # = `finch run`
#
# Note: `finch update` (the atomic self-update) is pointless inside a container —
# upgrade by rebuilding/pulling a newer image instead.

# Release builds should override these with digest-pinned references.
ARG GO_BUILD_IMAGE=golang:1.26.4-alpine3.23
ARG ALPINE_RUNTIME_IMAGE=alpine:3.23.3

FROM ${GO_BUILD_IMAGE} AS build
ARG VERSION=dev
ARG GO_SUM_SHA256=""
WORKDIR /src
COPY go.mod go.sum ./
RUN if [ -n "${GO_SUM_SHA256}" ]; then \
      printf '%s  %s\n' "${GO_SUM_SHA256}" go.sum | sha256sum --check --strict -; \
    fi \
    && go mod download
COPY . .
RUN CGO_ENABLED=0 go build -buildvcs=false -trimpath \
    -ldflags "-s -w -X github.com/digibugcat/finch/agent/core.agentVersion=${VERSION}" \
    -o /finch .

FROM ${ALPINE_RUNTIME_IMAGE}
ARG FINCH_UID=10001
ARG FINCH_GID=10001
RUN apk add --no-cache ca-certificates \
    && addgroup -S -g "${FINCH_GID}" finch \
    && adduser -S -D -H -u "${FINCH_UID}" -G finch -h /data finch \
    && mkdir -p /data \
    && chown finch:finch /data \
    && chmod 0700 /data
ENV HOME=/data
WORKDIR /data
VOLUME /data
USER finch
COPY --from=build /finch /usr/local/bin/finch
COPY --chmod=0555 docker-entrypoint.sh /usr/local/bin/finch-container-entrypoint
ENTRYPOINT ["finch-container-entrypoint"]
CMD ["run"]
