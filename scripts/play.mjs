import { execSync, spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const HTTP_PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const USE_HTTPS = process.env.HTTPS !== "0";
const ports = USE_HTTPS ? [HTTP_PORT, HTTPS_PORT] : [HTTP_PORT];
const resetCert = process.argv.includes("--reset-cert");

function pidsOnPort(port) {
  try {
    const out = execSync(`lsof -ti tcp:${port}`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

let killedAny = false;
for (const port of ports) {
  const pids = pidsOnPort(port);
  if (!pids.length) {
    console.log(`Port ${port} free.`);
    continue;
  }
  console.log(`Port ${port} in use by PID(s) ${pids.join(", ")} — killing.`);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {}
  }
  killedAny = true;
}

if (killedAny) {
  await wait(400);
  for (const port of ports) {
    const stubborn = pidsOnPort(port);
    for (const pid of stubborn) {
      console.log(`PID ${pid} still on ${port} — SIGKILL.`);
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
  }
  await wait(150);
}

console.log("Building...");
execSync("npm run build", { stdio: "inherit" });

console.log(`Starting server${USE_HTTPS ? " (HTTPS enabled)" : ""}...`);
const env = { ...process.env };
if (USE_HTTPS) env.HTTPS = "1";
if (resetCert) env.REGEN_CERT = "1";

const server = spawn("node", ["server.mjs"], { env, stdio: "inherit" });

const forward = (sig) => () => server.kill(sig);
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));

server.on("exit", (code, sig) => {
  if (sig) process.kill(process.pid, sig);
  else process.exit(code ?? 0);
});
