GO ?= go
NPM ?= npm
VERSION ?= dev
COMMIT ?= unknown
BUILD_DATE ?= unknown
CGO_CFLAGS ?= -Wno-deprecated-declarations
LDFLAGS := -s -w -X github.com/intellisys-stevens/miglens/internal/cli.Version=$(VERSION) -X github.com/intellisys-stevens/miglens/internal/cli.Commit=$(COMMIT) -X github.com/intellisys-stevens/miglens/internal/cli.BuildDate=$(BUILD_DATE)

.PHONY: bootstrap generate fmt frontend build test test-go test-race test-install license-check vulncheck soak soak-one-hour clean

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

build: frontend
	mkdir -p bin
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) build -trimpath -buildvcs=false -ldflags '$(LDFLAGS)' -o bin/miglens ./cmd/miglens

test-go:
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) test ./...
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) vet ./...

test-race:
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) test -race ./...

test-install:
	scripts/install_test.sh

license-check:
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) run github.com/google/go-licenses/v2@v2.0.1 check ./cmd/miglens --disallowed_types=forbidden,restricted,unknown
	cd web && $(NPM) run license:check

test: test-go test-race test-install frontend license-check

vulncheck:
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...
	cd web && $(NPM) audit

soak:
	CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) test ./internal/collector -run TestAcceleratedSoak -count=1

soak-one-hour:
	MIGLENS_SOAK=1 CGO_CFLAGS='$(CGO_CFLAGS)' $(GO) test ./internal/collector -run TestOneHourSoak -count=1 -timeout=65m

clean:
	$(GO) clean
	-rm -f bin/miglens
