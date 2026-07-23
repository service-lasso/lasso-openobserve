import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageOpenObserve } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const version = process.env.OPENOBSERVE_VERSION ?? "v0.10.8-rc4";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(port, timeoutMs = 90_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status === 200) {
        return;
      }
      lastError = new Error(`Unexpected health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  throw lastError ?? new Error(`Timed out waiting for OpenObserve on ${port}.`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(10_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

async function findManifestFiles(dir) {
  const ignored = new Set([".git", "node_modules", "output", "dist"]);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignored.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findManifestFiles(fullPath));
    } else if (entry.name === "service.json" || fullPath.endsWith(path.join("docs", "reference", "EXAMPLE-service.json"))) {
      files.push(fullPath);
    }
  }

  return files;
}

function findSingularHealthcheckKeys(value, trail = []) {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSingularHealthcheckKeys(item, [...trail, String(index)]));
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const childTrail = [...trail, key];
    const legacyHealthKey = "health" + "check";
    const matches = key === legacyHealthKey ? [childTrail.join(".")] : [];
    return [...matches, ...findSingularHealthcheckKeys(child, childTrail)];
  });
}

function validateHealthchecks(manifest, manifestPath) {
  const singularKeys = findSingularHealthcheckKeys(manifest);
  if (singularKeys.length > 0) {
    throw new Error(`${path.relative(repoRoot, manifestPath)} still declares legacy single-check keys: ${singularKeys.join(", ")}`);
  }

  if (manifest.healthchecks === undefined) {
    return;
  }

  if (!Array.isArray(manifest.healthchecks) || manifest.healthchecks.length === 0) {
    throw new Error(`${path.relative(repoRoot, manifestPath)} must declare a non-empty healthchecks array.`);
  }

  const ids = new Set();
  for (const check of manifest.healthchecks) {
    if (!check || typeof check !== "object") {
      throw new Error(`${path.relative(repoRoot, manifestPath)} contains a non-object healthchecks item.`);
    }
    if (typeof check.id !== "string" || check.id.trim() === "") {
      throw new Error(`${path.relative(repoRoot, manifestPath)} contains a healthchecks item without a stable id.`);
    }
    if (ids.has(check.id)) {
      throw new Error(`${path.relative(repoRoot, manifestPath)} contains duplicate healthchecks id "${check.id}".`);
    }
    ids.add(check.id);
    if (typeof check.type !== "string" || check.type.trim() === "") {
      throw new Error(`${path.relative(repoRoot, manifestPath)} healthchecks item "${check.id}" is missing type.`);
    }
  }
}

for (const manifestPath of await findManifestFiles(repoRoot)) {
  validateHealthchecks(JSON.parse(await readFile(manifestPath, "utf8")), manifestPath);
}

const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
if (serviceManifest.id !== "openobserve" || serviceManifest.version !== version) {
  throw new Error(`Unexpected service manifest identity: ${JSON.stringify({ id: serviceManifest.id, version: serviceManifest.version })}`);
}

const [openObserveHealthcheck] = serviceManifest.healthchecks ?? [];
if (
  openObserveHealthcheck?.id !== "openobserve-http-ready"
  || openObserveHealthcheck.type !== "http"
  || openObserveHealthcheck.url !== "http://${ZO_HTTP_ADDR}:${ZO_HTTP_PORT}/healthz"
  || openObserveHealthcheck.expected_status !== 200
  || serviceManifest.ports?.service !== 5080
) {
  throw new Error(`OpenObserve service.json healthchecks/ports drifted: ${JSON.stringify(serviceManifest.healthchecks)}`);
}

const artifact = await packageOpenObserve(platform);
const verifyRoot = path.join(repoRoot, "output", "verify", version, platform);
const serviceRoot = path.join(verifyRoot, "service");
const extractRoot = path.join(serviceRoot, ".state", "extracted", "current");
const dataRoot = path.join(serviceRoot, "runtime", "data");
const httpPort = await reserveLoopbackPort();
const grpcPort = await reserveLoopbackPort();

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });

if (artifact.endsWith(".zip")) {
  run("powershell", [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    `Expand-Archive -Path ${JSON.stringify(artifact)} -DestinationPath ${JSON.stringify(extractRoot)} -Force`,
  ]);
} else {
  run("tar", ["-xzf", artifact, "-C", extractRoot]);
}

const metadata = JSON.parse(await readFile(path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json"), "utf8"));
if (metadata.serviceId !== "openobserve" || metadata.upstream?.version !== version || metadata.packagedBy !== "service-lasso/lasso-openobserve") {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(metadata)}`);
}

const binary = path.join(extractRoot, platform === "win32" ? "openobserve.exe" : "openobserve");
const child = spawn(binary, [], {
  cwd: extractRoot,
  env: {
    ...process.env,
    ZO_HTTP_ADDR: "127.0.0.1",
    ZO_HTTP_PORT: String(httpPort),
    ZO_GRPC_ADDR: "127.0.0.1",
    ZO_GRPC_PORT: String(grpcPort),
    ZO_DATA_DIR: dataRoot,
    ZO_LOCAL_MODE: "true",
    ZO_LOCAL_MODE_STORAGE: "disk",
    ZO_ROOT_USER_EMAIL: "root@service-lasso.local",
    ZO_ROOT_USER_PASSWORD: "service-lasso-openobserve",
    ZO_HEALTH_CHECK_ENABLED: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout?.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForHealth(httpPort);
  console.log("[lasso-openobserve] verification passed");
} catch (error) {
  console.error("[lasso-openobserve] stdout:");
  console.error(stdout);
  console.error("[lasso-openobserve] stderr:");
  console.error(stderr);
  throw error;
} finally {
  await stopChild(child);
}
