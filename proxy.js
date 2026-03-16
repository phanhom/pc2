import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

// ==========================================
// CLI Arguments
// ==========================================
const { values: cliArgs } = parseArgs({
  options: {
    port: { type: "string", short: "p", default: process.env.PORT || "3101" },
    cwd: { type: "string", short: "d", default: process.cwd() },
    adapter: {
      type: "string",
      short: "a",
      default: "claude",
    },
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
  -a, --adapter <type>    Default adapter: claude | cursor | codex (default: claude)
  -h, --help              Show this help message

Examples:
  node proxy.js                          # Start with defaults (claude on port 3101)
  node proxy.js -p 4000 -a cursor       # Cursor on port 4000
  node proxy.js --cwd ~/projects         # Use ~/projects as default working directory
  PORT=8080 node proxy.js               # Port from environment variable

Environment Variables:
  PORT                    Listen port (overridden by --port)
  ANTHROPIC_API_KEY       Required for Claude API-key mode
  OPENAI_API_KEY          Required for Codex
`);
  process.exit(0);
}

const PORT = Number(cliArgs.port);
const DEFAULT_CWD = cliArgs.cwd;
const DEFAULT_ADAPTER = cliArgs.adapter;

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
  return DEFAULT_ADAPTER;
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
// HTTP Server
// ==========================================
const server = createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", adapter: DEFAULT_ADAPTER }));
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
        const builder = ADAPTERS[adapterName];

        console.log(`\n${"=".repeat(50)}`);
        console.log(`[proxy] heartbeat received`);
        console.log(`[proxy] adapter=${adapterName} agent=${payload.agentId} run=${runId}`);

        if (!builder) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Unknown adapter: ${adapterName}` }));
          return;
        }

        const { command, args, prompt } = builder(config, runId);
        const cwd = config.cwd || DEFAULT_CWD;

        // Flatten env bindings (Paperclip stores them as { KEY: { type: "plain", value: "..." } })
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

        // Try to extract usage/model/cost from Claude's stream-json output
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
  console.log(`
${"=".repeat(54)}
 Paperclip Remote Agent Proxy  v1.0.0
${"=".repeat(54)}
 Adapter : ${DEFAULT_ADAPTER}
 Listen  : http://0.0.0.0:${PORT}/heartbeat
 Health  : http://0.0.0.0:${PORT}/health
 CWD     : ${DEFAULT_CWD}
${"=".repeat(54)}

 Setup in Paperclip UI:
 1. Create agent -> select "${DEFAULT_ADAPTER} (remote)"
 2. Set Remote URL to: http://<THIS_IP>:${PORT}/heartbeat
${"=".repeat(54)}
`);
});
