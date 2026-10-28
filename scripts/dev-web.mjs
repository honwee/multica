import { spawn } from "node:child_process";
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
  const child = spawn(
    "pnpm",
    ["--filter", "@multica/web", "exec", "next", "dev", "--webpack", ...normalizeWebDevArgs(process.argv.slice(2))],
    { stdio: "inherit" },
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
