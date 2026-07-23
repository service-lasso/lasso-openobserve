# lasso-openobserve

`lasso-openobserve` packages OpenObserve as a Service Lasso managed service.

OpenObserve is an app-owned observability service for local logs, metrics, traces, and UI-driven inspection. It is disabled by default because retained telemetry data, credentials, and routing belong to the consuming app.

## Service Contract

- Service ID: `openobserve`
- Upstream version: `v0.10.8-rc4`
- Default HTTP port: `5080`
- Default gRPC port: `5081`
- Healthchecks: `openobserve-http-ready` probes `GET http://127.0.0.1:${SERVICE_PORT}/healthz`
- First package platforms: Windows, Linux, macOS arm64

## Release Artifacts

Pushes to `main` create a GitHub release named with the Service Lasso version pattern:

```text
yyyy.m.d-<shortsha>
```

The release contains:

- `lasso-openobserve-v0.10.8-rc4-win32.zip`
- `lasso-openobserve-v0.10.8-rc4-linux.tar.gz`
- `lasso-openobserve-v0.10.8-rc4-darwin.tar.gz`
- `service.json`
- `SHA256SUMS.txt`

## Local Validation

```powershell
npm test
```

The verifier downloads the OpenObserve upstream release asset for the current platform, repackages it, starts it with temporary data, checks `/healthz`, and stops the process.

## Consumer Notes

Consumers should set app-specific credentials and data retention policy. The default manifest values are safe for local development only:

- `ZO_ROOT_USER_EMAIL=root@service-lasso.local`
- `ZO_ROOT_USER_PASSWORD=service-lasso-openobserve`
