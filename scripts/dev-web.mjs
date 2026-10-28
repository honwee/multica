import { spawn } from "node:child_process";
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

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
  const nextBinary = webRequire.resolve("next/dist/bin/next");
  const child = spawn(
    process.execPath,
    [nextBinary, "dev", "--webpack", ...normalizeWebDevArgs(process.argv.slice(2))],
    { cwd: fileURLToPath(new URL("../apps/web/", import.meta.url)), stdio: "inherit" },
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
