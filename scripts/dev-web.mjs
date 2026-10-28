import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeWebDevArgs(args) {
  return args.map((arg) => {
    if (arg === "--host") return "--hostname";
    if (arg.startsWith("--host=")) return `--hostname=${arg.slice("--host=".length)}`;
    return arg;
  });
}

export function loadWebPreviewEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const config = JSON.parse(readFileSync(filePath, "utf8"));
  const remoteApiUrl = typeof config.remoteApiUrl === "string" ? config.remoteApiUrl.trim() : "";
  if (!remoteApiUrl) return {};
  const protocol = new URL(remoteApiUrl).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("preview.remoteApiUrl must use HTTP or HTTPS");
  }
  return { REMOTE_API_URL: remoteApiUrl, NEXT_PUBLIC_API_URL: "", NEXT_PUBLIC_WS_URL: "" };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
  const nextBinary = webRequire.resolve("next/dist/bin/next");
  const previewEnv = loadWebPreviewEnv(fileURLToPath(new URL("../apps/web/preview.local.json", import.meta.url)));
  const child = spawn(
    process.execPath,
    [nextBinary, "dev", "--webpack", ...normalizeWebDevArgs(process.argv.slice(2))],
    {
      cwd: fileURLToPath(new URL("../apps/web/", import.meta.url)),
      env: { ...process.env, ...previewEnv },
      stdio: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.once("error", (error) => {
    console.error(error);
    process.exit(1);
  });
  child.once("exit", (code) => process.exit(code ?? 1));
}
