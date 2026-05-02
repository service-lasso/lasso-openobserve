import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.OPENOBSERVE_VERSION ?? "v0.10.8-rc4";
const platform = process.env.TARGET_PLATFORM ?? process.platform;

const targets = {
  win32: {
    upstreamAsset: `openobserve-${version}-windows-amd64.zip`,
    outputAsset: `lasso-openobserve-${version}-win32.zip`,
    archiveType: "zip",
    binaryName: "openobserve.exe",
  },
  linux: {
    upstreamAsset: `openobserve-${version}-linux-amd64.tar.gz`,
    outputAsset: `lasso-openobserve-${version}-linux.tar.gz`,
    archiveType: "tar.gz",
    binaryName: "openobserve",
  },
  darwin: {
    upstreamAsset: `openobserve-${version}-darwin-arm64.tar.gz`,
    outputAsset: `lasso-openobserve-${version}-darwin.tar.gz`,
    archiveType: "tar.gz",
    binaryName: "openobserve",
  },
};

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

async function extractArchive(archivePath, destination, archiveType) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  if (archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(destination)} -Force`,
    ]);
    return;
  }

  run("tar", ["-xzf", archivePath, "-C", destination]);
}

async function compressPackage(packageRoot, outputPath, archiveType) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  if (archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path ${JSON.stringify(path.join(packageRoot, "*"))} -DestinationPath ${JSON.stringify(outputPath)} -Force`,
    ]);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

function findBinary(root, binaryName) {
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const args =
    process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-Command", `(Get-ChildItem -Path ${JSON.stringify(root)} -Recurse -Filter ${JSON.stringify(binaryName)} | Select-Object -First 1).FullName`]
      : ["-lc", `find ${JSON.stringify(root)} -type f -name ${JSON.stringify(binaryName)} | head -n 1`];
  const result = spawnSync(shell, args, { cwd: repoRoot, encoding: "utf8", shell: false });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not find ${binaryName} under ${root}`);
  }
  return result.stdout.trim();
}

export async function packageOpenObserve(targetPlatform = platform) {
  const target = targets[targetPlatform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${targetPlatform}. Supported platforms: ${Object.keys(targets).join(", ")}.`);
  }

  const workRoot = path.join(repoRoot, "output", "package", version, targetPlatform);
  const downloadRoot = path.join(workRoot, "download");
  const extractRoot = path.join(workRoot, "extract");
  const packageRoot = path.join(workRoot, "payload");
  const archivePath = path.join(downloadRoot, target.upstreamAsset);
  const outputPath = path.join(repoRoot, "dist", target.outputAsset);

  await rm(workRoot, { recursive: true, force: true });
  await mkdir(downloadRoot, { recursive: true });
  await mkdir(packageRoot, { recursive: true });

  if (!existsSync(archivePath)) {
    run("gh", ["release", "download", version, "--repo", "openobserve/openobserve", "--pattern", target.upstreamAsset, "--dir", downloadRoot]);
  }

  await extractArchive(archivePath, extractRoot, target.archiveType);
  const binaryPath = findBinary(extractRoot, target.binaryName);
  await cp(binaryPath, path.join(packageRoot, target.binaryName));

  if (targetPlatform !== "win32") {
    await chmod(path.join(packageRoot, target.binaryName), 0o755);
  }

  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "openobserve",
        upstream: {
          repo: "openobserve/openobserve",
          version,
          asset: target.upstreamAsset,
        },
        migratedFrom: {
          sourcePath: "services/openobserve",
          sourceVersion: "v0.10.8-rc4",
        },
        packagedBy: "service-lasso/lasso-openobserve",
        platform: targetPlatform,
        command: target.binaryName,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await compressPackage(packageRoot, outputPath, target.archiveType);
  console.log(`[lasso-openobserve] packaged ${outputPath}`);
  return outputPath;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageOpenObserve();
}
