# OpenObserve Service

This repo owns the Service Lasso manifest and release artifact for OpenObserve.

The package step downloads upstream OpenObserve release assets, extracts the single binary, and repackages it with Service Lasso provenance metadata.

The verifier starts OpenObserve with temporary data and local development credentials, waits for `/healthz`, and then stops the process.
