GO ?= go
NPM ?= npm
DOCKER ?= docker
HELM ?= helm
VERSION ?= dev
COMMIT ?= unknown
BUILD_DATE ?= unknown
CGO_CFLAGS ?= -Wno-deprecated-declarations
BRIDGE_IMAGE ?= leviathan-kubernetes-bridge:$(VERSION)
DIST_DIR ?= dist
LDFLAGS := -s -w -X github.com/intellisys-stevens/leviathan/internal/cli.Version=$(VERSION) -X github.com/intellisys-stevens/leviathan/internal/cli.Commit=$(COMMIT) -X github.com/intellisys-stevens/leviathan/internal/cli.BuildDate=$(BUILD_DATE)
BRIDGE_LDFLAGS := -s -w -X main.BridgeVersion=$(VERSION)

.PHONY: bootstrap generate fmt frontend build build-leviathan build-bridge bridge-image branding-check repository-boundary-check release-metadata-check helm-check helm-package test test-go test-race test-install test-jetstream-bootstrap license-check vulncheck soak soak-one-hour clean

bootstrap:
	cd web && $(NPM) ci

generate:
	$(GO) generate ./internal/api
	cd web && $(NPM) run generate:api

fmt:
	$(GO) fmt ./...
	cd web && $(NPM) run format -- --write

frontend:
	cd web && $(NPM) audit
	cd web && $(NPM) run license:check
	cd web && $(NPM) run lint
	cd web && $(NPM) run format -- --check
	cd web && $(NPM) test
	cd web && $(NPM) run build

build: frontend build-leviathan build-bridge

build-leviathan:
	mkdir -p bin
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) build -trimpath -buildvcs=false -ldflags '$(LDFLAGS)' -o bin/leviathan ./cmd/leviathan

build-bridge:
	mkdir -p bin
	CGO_ENABLED=0 $(GO) build -trimpath -buildvcs=false -ldflags '$(BRIDGE_LDFLAGS)' -o bin/leviathan-kubernetes-bridge ./cmd/leviathan-kubernetes-bridge

bridge-image:
	$(DOCKER) build --file contrib/container/leviathan-kubernetes-bridge.Dockerfile --build-arg VERSION='$(VERSION)' --build-arg COMMIT='$(COMMIT)' --build-arg BUILD_DATE='$(BUILD_DATE)' --tag '$(BRIDGE_IMAGE)' .

branding-check:
	scripts/verify-branding.sh

repository-boundary-check:
	scripts/verify-repository-boundary.sh

release-metadata-check:
	scripts/verify-release-metadata.sh

helm-check:
	HELM='$(HELM)' scripts/verify-helm-chart.sh

helm-package: helm-check
	mkdir -p '$(DIST_DIR)'
	$(HELM) package charts/leviathan-attribution --destination '$(DIST_DIR)'

test-go:
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) test ./...
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) vet ./...

test-race:
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) test -race ./...

test-install:
	scripts/install_test.sh

test-jetstream-bootstrap:
	scripts/bootstrap-jetstream-uplink_test.sh

license-check:
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) run github.com/google/go-licenses/v2@v2.0.1 check ./cmd/leviathan --disallowed_types=forbidden,restricted,unknown
	$(GO) run github.com/google/go-licenses/v2@v2.0.1 check ./cmd/leviathan-kubernetes-bridge --disallowed_types=forbidden,restricted,unknown
	cd web && $(NPM) run license:check

test: test-go test-race test-install test-jetstream-bootstrap frontend branding-check repository-boundary-check release-metadata-check helm-check license-check

vulncheck:
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...
	cd web && $(NPM) audit

soak:
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) test ./internal/collector -run TestAcceleratedSoak -count=1

soak-one-hour:
	LEVIATHAN_SOAK=1 CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) test ./internal/collector -run TestOneHourSoak -count=1 -timeout=65m

clean:
	$(GO) clean
	-rm -f bin/leviathan bin/leviathan-kubernetes-bridge
