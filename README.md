# Paperclip Remote Agent Proxy (pc2)

Run Claude Code, Cursor, or Codex on a **remote machine** — controlled by your Paperclip server.

## One-Command Install & Run

```bash
# Clone and start (defaults to Claude on port 3101)
git clone https://github.com/phanhom/pc2.git && cd pc2 && node proxy.js
```

Or with options:

```bash
node proxy.js --adapter cursor --port 4000 --cwd ~/my-project
```

## Requirements

- **Node.js 18+** (no npm install needed — zero dependencies)
- One of these CLI tools installed on this machine:
  - `claude` — [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
  - `cursor` — [Cursor CLI](https://docs.cursor.com)
  - `codex` — [OpenAI Codex CLI](https://github.com/openai/codex)
- The CLI tool must be **already authenticated** (run it once manually first)

## Connect to Paperclip

1. Open your Paperclip UI (e.g. `http://your-server:3100`)
2. **Agents → New Agent**
3. Choose **"Claude (Remote)"**, **"Cursor (Remote)"**, or **"Codex (Remote)"**
4. In the **Remote Agent URL** field, enter: `http://<THIS_MACHINE_IP>:3101/heartbeat`
5. Configure model, instructions, etc. as usual
6. Create the agent and assign tasks!

## CLI Options

```
Usage: node proxy.js [options]

Options:
  -p, --port <port>       Listen port (default: 3101, or $PORT)
  -d, --cwd <path>        Default working directory for agent execution
  -a, --adapter <type>    Default adapter: claude | cursor | codex (default: claude)
  -h, --help              Show help
```

## Health Check

```bash
curl http://localhost:3101/health
# => {"status":"ok","adapter":"claude"}
```

## How It Works

```
┌─────────────────┐         HTTP POST          ┌─────────────────┐
│  Paperclip      │  ────────────────────────>  │  This Proxy     │
│  Server         │  /heartbeat                 │  (remote machine)│
│  (your laptop   │                             │                  │
│   or cloud)     │  <────────────────────────  │  spawns claude/  │
│                 │  JSON response with         │  cursor/codex    │
│                 │  usage, cost, summary       │  locally         │
└─────────────────┘                             └─────────────────┘
```

1. Paperclip sends agent config + task context via `POST /heartbeat`
2. Proxy spawns the appropriate CLI tool (claude/cursor/codex) locally
3. Proxy captures output, parses usage/cost data (for Claude)
4. Proxy returns structured results back to Paperclip

## Environment Variables

The proxy passes through environment variables from its own process to the spawned agent. Set these before starting:

```bash
# For Claude API-key mode
export ANTHROPIC_API_KEY=sk-ant-...

# For Codex
export OPENAI_API_KEY=sk-...

# Then start
node proxy.js
```

## Current Limitations

- **No real-time log streaming** — Paperclip receives results after the run completes (not streamed live to the UI)
- **No session resume** — Each heartbeat starts a fresh CLI session
- These will be improved in future versions

## License

MIT
