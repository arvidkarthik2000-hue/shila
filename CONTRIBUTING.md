# Contributing to SHILA

Every number in SHILA must come from a public source, and every estimate must be checked against a measurement. Contributions that add either are welcome.

## 1. Submit a benchmark (no code)

Open a [benchmark issue](https://github.com/arvidkarthik2000-hue/shila/issues/new?template=benchmark.yml). Best evidence:

```sh
llama-bench -m model.gguf -p 2048 -n 256 -fa 1        # plus -ngl / --n-cpu-moe as you run it
```

Include the machine (CPU/chip, RAM size and type, GPU and VRAM, OS), the engine and its version, the file, the context, and any drafting flags. Accepted results are added to the model's `anchors` in `data/models.json`; if the estimate for that box is more than 30% off, the result also goes into `test/calibration.json` and the estimator is corrected.

## 2. Add or correct data

All data lives in `data/`:

- **models.json**: one entry per model. Required: `id`, `name`, `hf`, `total`, `active` (billions), `kind` (`dense`/`moe`), `layers`, `attnLayers` (layers with a growing KV cache), `kvBytes` (bytes per token, K+V, fp16), `ctxMax`, `license`, `released`, and `quants` (`tag`, `gb` from the Hugging Face file listing, `fmt` = `gguf`/`mlx`/`nvfp4`/`fp8`/`bf16`, `repo`). MoE models also need `expertWeightFrac` and `expertActiveFrac`. Measured results go in `anchors` with a `src` URL.
- **hardware.json**: one entry per machine. Required: `id`, `group`, `name`, `ram`, `ramBw` (spec) and `ramBwEff` (measured if known), `cpuClass`, `gpu` (or `null`), `unified`, `os`, `pflopsGpu`/`pflopsCpu`, and a price (`priceInr` range with `priceNote` naming the listing and date, or `priceUsd`).
- Engines are code, in `src/core.js` (`ENGINES`): each has a `check(hw, model, pick, opts)` that returns `null` when it does not apply, or a score, reasons, caveats and the commands. Commands must come from the engine's own README.

Then:

```sh
npm test            # calibration, MCP, parser and site tests
npm run build       # rebuilds docs/index.html (commit it; CI checks it is current)
```

## 3. Reddit radar

`.github/workflows/reddit-radar.yml` scans r/LocalLLaMA once a day (`scripts/reddit-radar.js`) and keeps one open issue labelled `radar` listing posts that look like a new model, or a tok/s measurement. It never edits `data/`: a person (or Claude) reads the thread, finds the primary source (model card, repo, benchmark post), and adds the numbers with that URL. Reddit often blocks anonymous requests from datacenter IPs; if the workflow reports HTTP 403, add `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` (a free Reddit "script" app) as repository secrets.

## 4. Ground rules

- Link a source for every number. Mark estimates as estimates.
- Paraphrase engine and model descriptions; do not copy README text.
- No telemetry, no network calls except Hugging Face, no dependencies in the runtime path.
