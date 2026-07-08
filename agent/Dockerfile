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

FROM golang:1.26-alpine AS build
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build \
    -ldflags "-s -w -X github.com/digibugcat/finch/agent/core.agentVersion=${VERSION}" \
    -o /finch .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates \
    && addgroup -S finch && adduser -S -G finch -h /data finch
ENV HOME=/data
WORKDIR /data
VOLUME /data
USER finch
COPY --from=build /finch /usr/local/bin/finch
ENTRYPOINT ["finch"]
CMD ["run"]
