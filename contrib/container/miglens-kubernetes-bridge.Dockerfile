# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM golang:1.27.0-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY internal/model/ ./internal/model/
COPY internal/provider/*.go ./internal/provider/
COPY internal/attribution/ ./internal/attribution/
COPY internal/kubernetesbridge/ ./internal/kubernetesbridge/
COPY cmd/miglens-kubernetes-bridge/ ./cmd/miglens-kubernetes-bridge/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -buildvcs=false \
    -ldflags="-s -w -X main.BridgeVersion=$VERSION" \
    -o /out/miglens-kubernetes-bridge ./cmd/miglens-kubernetes-bridge

FROM scratch
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="MIGLens Kubernetes attribution bridge" \
      org.opencontainers.image.description="Node-local Kubernetes DRA attribution bridge for MIGLens" \
      org.opencontainers.image.source="https://github.com/intellisys-stevens/miglens" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$COMMIT \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /out/miglens-kubernetes-bridge /miglens-kubernetes-bridge
COPY LICENSE NOTICE /licenses/
USER 0:0
ENTRYPOINT ["/miglens-kubernetes-bridge"]
