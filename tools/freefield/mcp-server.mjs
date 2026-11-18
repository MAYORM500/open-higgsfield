#!/usr/bin/env node
// MCP server (stdio, no dependencies) that exposes Freefield's apps to Claude Code.
// Freefield lives in FREEFIELD_DIR (default <repo>/.freefield, installed by tools/freefield/setup.sh).
// Each app is apps/<id>/app.json; runs go through Freefield's own CLI (server/cli.ts app ...),
// which talks to the GPU backend named by COMFY_BASE_URL / FREEFIELD_TOKEN in FREEFIELD_DIR/.env.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FF = resolve(process.env.FREEFIELD_DIR ?? join(repoRoot, ".freefield"));
const OUT_ROOT = resolve(process.env.FREEFIELD_OUT ?? join(repoRoot, "out", "freefield"));
const RUN_TIMEOUT_MS = Number(process.env.FREEFIELD_RUN_TIMEOUT_MS ?? 30 * 60 * 1000);
const PROTOCOL = "2025-06-18";

// ---------- Freefield data ----------

function installed() {
  return existsSync(join(FF, "apps")) && existsSync(join(FF, "server", "cli.ts"));
}

function notInstalled() {
  return `Freefield is not installed at ${FF}. Run: bash tools/freefield/setup.sh`;
}

function loadApps() {
  const dir = join(FF, "apps");
  const apps = [];
  for (const id of readdirSync(dir).sort()) {
    const p = join(dir, id, "app.json");
    if (!existsSync(p)) continue;
    try {
      apps.push(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      /* the validator reports broken manifests; skip them here */
    }
  }
  return apps;
}

function readEnv() {
  const env = {};
  const p = join(FF, ".env");
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function backendConfig() {
  const env = { ...readEnv(), ...pick(process.env, ["COMFY_BASE_URL", "FREEFIELD_TOKEN"]) };
  const url = env.COMFY_BASE_URL ?? "";
  const placeholder = !url || url.includes("YOUR-WORKSPACE");
  return { url: placeholder ? null : url, token_set: Boolean(env.FREEFIELD_TOKEN) };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k]) out[k] = obj[k];
  return out;
}

function summarizeInput(i) {
  const s = { id: i.id, type: i.type, label: i.label };
  if (i.required) s.required = true;
  if (i.default !== undefined && i.default !== "") s.default = i.default;
  if (i.help) s.help = i.help;
  if (i.min !== undefined) s.min = i.min;
  if (i.max !== undefined) s.max = i.max;
  if (i.multiple) s.multiple = true;
  if (Array.isArray(i.options)) {
    s.options = i.options.map((o) => (typeof o === "object" ? { value: o.value, label: o.label } : o));
  }
  return s;
}

// ---------- tools ----------

const tools = [
  {
    name: "freefield_status",
    description:
      "Is Freefield installed, and is a GPU backend configured? Call this first. Generation needs COMFY_BASE_URL in .freefield/.env pointing at a Freefield gateway (Modal, RunPod/Vast.ai, or a local GPU).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      if (!installed()) return { installed: false, dir: FF, fix: "bash tools/freefield/setup.sh" };
      const apps = loadApps();
      const backend = backendConfig();
      return {
        installed: true,
        dir: FF,
        apps: apps.length,
        ready: apps.filter((a) => a.status === "ready").length,
        npm_installed: existsSync(join(FF, "node_modules", "@comfyorg", "sdk")),
        backend_url: backend.url,
        token_set: backend.token_set,
        can_generate: Boolean(backend.url && backend.token_set),
        how_to_connect_backend: backend.url
          ? undefined
          : "Set COMFY_BASE_URL (and FREEFIELD_TOKEN) in .freefield/.env: the URL from `modal deploy infra/modal_app.py`, a RunPod/Vast.ai Freefield pod, or http://127.0.0.1:8000 from `python tools/local_backend.py serve`. See .freefield/README.md 'Run it'.",
      };
    },
  },
  {
    name: "freefield_list_apps",
    description:
      "List Freefield apps (open-weights Higgsfield-style image, video, VFX and audio apps on ComfyUI). Filter by section (image, video, audio, ...) or a search string.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", description: "e.g. image, video, audio" },
        query: { type: "string", description: "substring matched against id, name and summary" },
        include_drafts: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    run: async ({ section, query, include_drafts } = {}) => {
      if (!installed()) throw new Error(notInstalled());
      const q = query?.toLowerCase();
      return loadApps()
        .filter((a) => include_drafts || a.status === "ready")
        .filter((a) => !section || a.section === section)
        .filter((a) => !q || `${a.id} ${a.name} ${a.summary ?? ""}`.toLowerCase().includes(q))
        .map((a) => ({ id: a.id, name: a.name, section: a.section, pack: a.pack, status: a.status, summary: a.summary }));
    },
  },
  {
    name: "freefield_describe_app",
    description:
      "Show one Freefield app's inputs (ids, types, defaults, options), presets, outputs and models, so you can call freefield_run_app with the right values.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    run: async ({ id }) => {
      if (!installed()) throw new Error(notInstalled());
      const app = loadApps().find((a) => a.id === id);
      if (!app) throw new Error(`unknown app "${id}"; use freefield_list_apps`);
      return {
        id: app.id,
        name: app.name,
        section: app.section,
        status: app.status,
        summary: app.summary,
        pack: app.pack,
        inputs: (app.inputs ?? []).map(summarizeInput),
        presets: (app.presets ?? []).map((p) => ({ id: p.id, label: p.label })),
        outputs: (app.outputs ?? []).map((o) => ({ type: o.type, label: o.label })),
        models: (app.models ?? []).map((m) => ({ file: m.file ?? m.name, repo: m.repo, size_gb: m.size_gb, license: m.license })),
        vram: app.vram,
      };
    },
  },
  {
    name: "freefield_run_app",
    description:
      "Run a Freefield app on the configured GPU backend and save its outputs. `values` sets text/number/select/toggle inputs; `files` maps image/video/audio input ids to local file paths. Returns the saved output paths. Can take minutes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "app id from freefield_list_apps" },
        values: {
          type: "object",
          description: "input id -> value (strings, numbers or booleans)",
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
        files: {
          type: "object",
          description: "input id -> path of a local file (absolute, or relative to the repo root)",
          additionalProperties: { type: "string" },
        },
        preset: { type: "string" },
        out_dir: { type: "string", description: "where to save outputs (default out/freefield/<app>-<time>)" },
        allow_draft: { type: "boolean", default: false },
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: async ({ id, values = {}, files = {}, preset, out_dir, allow_draft }) => {
      if (!installed()) throw new Error(notInstalled());
      if (!loadApps().some((a) => a.id === id)) throw new Error(`unknown app "${id}"; use freefield_list_apps`);
      const backend = backendConfig();
      if (!backend.url) throw new Error("No GPU backend configured: set COMFY_BASE_URL in .freefield/.env (see freefield_status)");

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const out = out_dir ? resolve(repoRoot, out_dir) : join(OUT_ROOT, `${id}-${stamp}`);
      mkdirSync(out, { recursive: true });

      const args = [
        "--env-file-if-exists=.env",
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        "server/cli.ts",
        "app",
        id,
      ];
      for (const [k, v] of Object.entries(values)) args.push("--set", `${k}=${v}`);
      for (const [k, p] of Object.entries(files)) {
        const path = isAbsolute(p) ? p : resolve(repoRoot, p);
        if (!existsSync(path)) throw new Error(`file for "${k}" not found: ${path}`);
        args.push("--file", `${k}=${path}`);
      }
      if (preset) args.push("--preset", preset);
      args.push("--out", out);
      if (allow_draft) args.push("--draft");

      const { code, stdout, stderr } = await run(process.execPath, args, FF, RUN_TIMEOUT_MS);
      const saved = [...stdout.matchAll(/^saved (.+)$/gm)].map((m) => resolve(FF, m[1]));
      if (code !== 0) throw new Error(`run failed (exit ${code}):\n${(stderr || stdout).trim().slice(-4000)}`);
      return { app: id, outputs: saved, out_dir: out, log: stdout.trim().slice(-2000) };
    },
  },
];

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      stderr += `\ntimed out after ${timeoutMs / 1000} s`;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: 1, stdout, stderr: String(e) });
    });
  });
}

// ---------- JSON-RPC over stdio ----------

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize":
        return send({
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "freefield", version: "0.1.0" },
          },
        });
      case "ping":
        return send({ id, result: {} });
      case "tools/list":
        return send({
          id,
          result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
        });
      case "tools/call": {
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool) return send({ id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
        try {
          const result = await tool.run(params?.arguments ?? {});
          return send({ id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
        } catch (e) {
          return send({ id, result: { isError: true, content: [{ type: "text", text: e.message ?? String(e) }] } });
        }
      }
      default:
        if (isRequest) send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    if (isRequest) send({ id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "parse error" } });
  }
  handle(msg);
});
