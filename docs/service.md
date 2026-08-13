# OpenObserve Service

This repo owns the Service Lasso manifest and release artifact for OpenObserve.

The root `service.json` authors Service Lasso interfaces through canonical `endpoints[]`:

- `service` is the local HTTP network endpoint.
- `grpc` is the local gRPC network endpoint.
- `ui` is the operator URL endpoint that targets `service`.
- `health` is the readiness URL endpoint used by the HTTP healthcheck.

The package step downloads upstream OpenObserve release assets, extracts the single binary, and repackages it with Service Lasso provenance metadata.

The verifier starts OpenObserve with temporary data and local development credentials, waits for `/healthz`, and then stops the process.
