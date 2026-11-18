# Freefield in Claude Code

[Freefield](https://github.com/neuregex/freefield) (open-source Higgsfield on ComfyUI, 120 open-weights apps) is
connected to Claude Code through the `freefield` MCP server in `.mcp.json`.

## Set up

```sh
bash tools/freefield/setup.sh      # clones Freefield into .freefield/ (gitignored) and runs npm install
```

Then restart Claude Code in this repo and approve the `freefield` server when asked (or run `/mcp`).

## Tools

| Tool | What it does |
|---|---|
| `freefield_status` | installed? backend configured? |
| `freefield_list_apps` | apps by section (`image`, `video`, `audio`…) or search text |
| `freefield_describe_app` | an app's inputs, options, presets, outputs and models |
| `freefield_run_app` | runs an app on the GPU backend; outputs go to `out/freefield/<app>-<time>/` |

## GPU backend

Generation needs a Freefield gateway. Put its URL in `.freefield/.env` as `COMFY_BASE_URL`, with the matching
`FREEFIELD_TOKEN`. You can use any one of:

- **Modal**: `modal deploy infra/modal_app.py` (run inside `.freefield/`)
- **RunPod / Vast.ai**: the one-click template in Freefield's README
- **Your own NVIDIA GPU**: `python tools/local_backend.py serve <dir>`, then `COMFY_BASE_URL=http://127.0.0.1:8000`

Optional environment variables for the server: `FREEFIELD_DIR`, `FREEFIELD_OUT`, `FREEFIELD_RUN_TIMEOUT_MS`.
