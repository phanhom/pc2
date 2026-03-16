import { createServer } from "node:http";
import { spawn, execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { networkInterfaces } from "node:os";

// ==========================================
// CLI Arguments
// ==========================================
const { values: cliArgs } = parseArgs({
  options: {
    port: { type: "string", short: "p", default: process.env.PORT || "3101" },
    cwd: { type: "string", short: "d", default: process.cwd() },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: false,
});

if (cliArgs.help) {
  console.log(`
Paperclip Remote Agent Proxy
Runs on a remote machine to execute AI agents on behalf of Paperclip Server.

Usage:
  node proxy.js [options]

Options:
  -p, --port <port>       Port to listen on (default: 3101, or $PORT)
  -d, --cwd <path>        Default working directory for agent execution
  -h, --help              Show this help message

Examples:
  node proxy.js                          # Start on port 3101
  node proxy.js -p 4000                  # Start on port 4000
  node proxy.js --cwd ~/projects         # Use ~/projects as default working directory

Environment Variables:
  PORT                    Listen port (overridden by --port)
  ANTHROPIC_API_KEY       Required for Claude API-key mode
  OPENAI_API_KEY          Required for Codex
`);
  process.exit(0);
}

const PORT = Number(cliArgs.port);
const DEFAULT_CWD = cliArgs.cwd;

// ==========================================
// Environment Detection
// ==========================================

function commandExists(cmd) {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getCommandVersion(cmd) {
  try {
    return execSync(`${cmd} --version 2>/dev/null`, { stdio: "pipe" }).toString().trim().split("\n")[0];
  } catch {
    return null;
  }
}

function detectAdapters() {
  const adapters = [
    { name: "claude", command: "claude", label: "Claude Code" },
    { name: "cursor", command: "cursor", label: "Cursor" },
    { name: "codex", command: "codex", label: "Codex" },
  ];

  const results = [];
  for (const adapter of adapters) {
    const exists = commandExists(adapter.command);
    const version = exists ? getCommandVersion(adapter.command) : null;
    results.push({ ...adapter, available: exists, version });
  }
  return results;
}

function getLocalIPs() {
  const interfaces = networkInterfaces();
  const ips = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        ips.push({ name, address: addr.address });
      }
    }
  }
  return ips;
}

async function getPublicIP() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("https://api.ipify.org?format=json", { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      return data.ip;
    }
  } catch {
    // ignore
  }
  return null;
}

// ==========================================
// Adapter command builders
// ==========================================
const ADAPTERS = {
  claude(config, runId) {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (config.model) args.push("--model", config.model);
    if (config.effort) args.push("--effort", config.effort);
    if (config.chrome) args.push("--chrome");
    if (config.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (config.maxTurnsPerRun > 0) args.push("--max-turns", String(config.maxTurnsPerRun));
    if (config.instructionsFilePath) args.push("--append-system-prompt-file", config.instructionsFilePath);
    const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs : [];
    if (extraArgs.length > 0) args.push(...extraArgs);

    return {
      command: config.command || "claude",
      args,
      prompt:
        config.promptTemplate ||
        `You are agent ${config.agentId ?? "unknown"}. Continue your Paperclip work. Run ID: ${runId}`,
    };
  },

  cursor(config, runId) {
    const args = ["--print", "-", "--output-format", "stream-json"];
    if (config.model) args.push("--model", config.model);
    if (config.instructionsFilePath) args.push("--append-system-prompt-file", config.instructionsFilePath);
    const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs : [];
    if (extraArgs.length > 0) args.push(...extraArgs);

    return {
      command: config.command || "cursor",
      args,
      prompt: config.promptTemplate || `You are a remote Cursor agent. Run ID: ${runId}`,
    };
  },

  codex(config, runId) {
    const args = ["--full-auto"];
    if (config.model) args.push("--model", config.model);
    if (config.instructionsFilePath) args.push("--instructions-file", config.instructionsFilePath);
    if (config.dangerouslyBypassApprovalsAndSandbox || config.dangerouslyBypassSandbox) {
      args.push("--dangerously-auto-approve");
    }

    return {
      command: config.command || "codex",
      args,
      prompt: config.promptTemplate || `You are a remote Codex agent. Run ID: ${runId}`,
    };
  },
};

function resolveAdapter(payload) {
  const configType = payload.config?.adapterType || payload.adapterType || "";
  if (configType.includes("claude")) return "claude";
  if (configType.includes("cursor")) return "cursor";
  if (configType.includes("codex")) return "codex";
  return null;
}

// ==========================================
// Process runner
// ==========================================
function runAgentCommand(command, args, cwd, env, promptData) {
  return new Promise((resolve) => {
    console.log(`[proxy] exec: ${command} ${args.join(" ")}`);
    console.log(`[proxy] cwd:  ${cwd}`);

    const proc = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    proc.on("error", (err) => {
      console.error(`[proxy] spawn error:`, err.message);
      resolve({ exitCode: 1, stdout, stderr, error: err.message });
    });

    proc.on("close", (code) => {
      console.log(`[proxy] exited code=${code}`);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    if (promptData) {
      proc.stdin.write(promptData);
      proc.stdin.end();
    }
  });
}

// ==========================================
// Parse Claude stream-json for usage
// ==========================================
function parseClaudeUsage(stdout) {
  let usage = null;
  let model = null;
  let costUsd = 0;
  let summary = "";

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "result") {
        usage = {
          inputTokens: obj.usage?.input_tokens ?? 0,
          outputTokens: obj.usage?.output_tokens ?? 0,
          cachedInputTokens: obj.usage?.cache_read_input_tokens ?? 0,
        };
        model = obj.model ?? null;
        costUsd = obj.total_cost_usd ?? 0;
        summary = obj.result ?? "";
      }
    } catch {
      // not JSON, skip
    }
  }

  return { usage, model, costUsd, summary };
}

// ==========================================
// Startup: detect environment, then start server
// ==========================================
async function main() {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       Paperclip Remote Agent Proxy  v1.0.0          ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("");

  // --- Detect available adapters ---
  console.log("  Detecting available agents...");
  console.log("");
  const adapters = detectAdapters();
  let anyAvailable = false;

  for (const a of adapters) {
    if (a.available) {
      anyAvailable = true;
      const ver = a.version ? ` (${a.version})` : "";
      console.log(`  ✅  ${a.label.padEnd(14)} found${ver}`);
    } else {
      console.log(`  ❌  ${a.label.padEnd(14)} not found — install to use ${a.label} (Remote)`);
    }
  }

  console.log("");

  if (!anyAvailable) {
    console.log("  ⚠️  No supported agents detected on this machine.");
    console.log("     Install at least one of:");
    console.log("       • Claude Code:  npm install -g @anthropic-ai/claude-code");
    console.log("       • Cursor:       https://docs.cursor.com/cli");
    console.log("       • Codex:        npm install -g @openai/codex");
    console.log("");
    console.log("     Starting anyway (will fail when heartbeat arrives)...");
    console.log("");
  }

  // --- Detect network IPs ---
  const localIPs = getLocalIPs();
  const publicIP = await getPublicIP();

  console.log("  Network addresses:");
  console.log("");
  for (const ip of localIPs) {
    console.log(`  🏠  LAN  ${ip.address.padEnd(18)} (${ip.name})`);
  }
  if (publicIP) {
    console.log(`  🌐  WAN  ${publicIP}`);
  }
  if (localIPs.length === 0 && !publicIP) {
    console.log("  ⚠️  Could not detect any network address");
  }

  console.log("");
  console.log("┌──────────────────────────────────────────────────────┐");
  console.log("│  Ready! Use one of these URLs in Paperclip UI:      │");
  console.log("│                                                      │");
  for (const ip of localIPs) {
    const url = `http://${ip.address}:${PORT}/heartbeat`;
    console.log(`│  → ${url.padEnd(50)} │`);
  }
  if (publicIP) {
    const url = `http://${publicIP}:${PORT}/heartbeat`;
    console.log(`│  → ${url.padEnd(50)} │`);
  }
  if (localIPs.length === 0 && !publicIP) {
    console.log(`│  → http://localhost:${PORT}/heartbeat${" ".repeat(50 - 26 - String(PORT).length)}│`);
  }
  console.log("│                                                      │");
  console.log("│  CWD: " + DEFAULT_CWD.slice(0, 47).padEnd(47) + " │");
  console.log("│                                                      │");
  console.log("│  Available adapters:                                 │");
  for (const a of adapters) {
    const status = a.available ? "✅" : "❌";
    console.log(`│    ${status}  ${a.label.padEnd(48)} │`);
  }
  console.log("└──────────────────────────────────────────────────────┘");
  console.log("");
  console.log("  Waiting for heartbeats from Paperclip Server...");
  console.log("");

  // --- Start HTTP server ---
  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      const available = adapters.filter((a) => a.available).map((a) => a.name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", adapters: available }));
      return;
    }

    // Heartbeat endpoint
    if (req.method === "POST" && req.url === "/heartbeat") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });

      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const { config = {}, context = {}, runId = "unknown" } = payload;
          const adapterName = resolveAdapter(payload);

          console.log(`\n${"─".repeat(54)}`);
          console.log(`[proxy] heartbeat received`);
          console.log(`[proxy] adapter=${adapterName || "auto"} agent=${payload.agentId} run=${runId}`);

          if (!adapterName || !ADAPTERS[adapterName]) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ exitCode: 1, errorMessage: `Unknown adapter type. Received: ${payload.config?.adapterType || payload.adapterType || "none"}` }));
            return;
          }

          const adapterInfo = adapters.find((a) => a.name === adapterName);
          if (adapterInfo && !adapterInfo.available) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              exitCode: 1,
              errorMessage: `${adapterInfo.label} is not installed on this machine. Run: npm install -g ${adapterName === "claude" ? "@anthropic-ai/claude-code" : adapterName === "codex" ? "@openai/codex" : adapterName}`,
            }));
            return;
          }

          const builder = ADAPTERS[adapterName];
          const { command, args, prompt } = builder(config, runId);
          const cwd = config.cwd || DEFAULT_CWD;

          // Flatten env bindings
          const flatEnv = {};
          if (config.env && typeof config.env === "object") {
            for (const [key, val] of Object.entries(config.env)) {
              if (typeof val === "string") {
                flatEnv[key] = val;
              } else if (val && typeof val === "object" && val.type === "plain") {
                flatEnv[key] = val.value;
              }
            }
          }

          const agentEnv = {
            ...process.env,
            ...flatEnv,
            PAPERCLIP_RUN_ID: runId,
            PAPERCLIP_AGENT_ID: payload.agentId || "",
            PAPERCLIP_COMPANY_ID: context.companyId || config.companyId || "",
          };

          const result = await runAgentCommand(command, args, cwd, agentEnv, prompt);

          const parsed = adapterName === "claude" ? parseClaudeUsage(result.stdout) : {};

          const responsePayload = {
            exitCode: result.exitCode,
            signal: null,
            timedOut: false,
            summary: parsed.summary || (result.exitCode === 0 ? "Remote execution completed" : "Remote execution failed"),
            errorMessage: result.error || (result.exitCode !== 0 ? `Exited with code ${result.exitCode}` : null),
            ...(parsed.usage ? { usage: parsed.usage } : {}),
            ...(parsed.model ? { provider: "anthropic", model: parsed.model } : {}),
            ...(parsed.costUsd ? { costUsd: parsed.costUsd } : {}),
            resultJson: { stdout: result.stdout.slice(-8000), stderr: result.stderr.slice(-4000) },
          };

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responsePayload));
          console.log(`[proxy] response sent`);
        } catch (err) {
          console.error(`[proxy] error:`, err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ exitCode: 1, errorMessage: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not Found\n");
  });

  server.listen(PORT, "0.0.0.0", () => {
    // already printed the banner above
  });
}

main();
