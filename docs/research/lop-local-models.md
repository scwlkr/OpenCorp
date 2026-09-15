# Local builder candidates for Levels of Proof

Research for [Research local builder candidates against the available machine](https://github.com/scwlkr/OpenCorp/issues/48). Checked **2026-09-15**. This is a trial shortlist, not a model qualification or a decision to install anything.

## Observed host and present uncertainty

Read-only local inspection found Apple M1 Max, 10 CPU cores, **64 GiB unified memory**, macOS 27.0 and Ollama 0.34.0. Approximately 245 GiB disk space was available at inspection; this is transient. Ollama reported no loaded models at that instant. No inference, downloads, installations or company changes were performed.

Installed metadata includes a Qwen3.5 4B Q4_K_M artifact (3.4 GB) and custom 27B Q4_K_M and 31.6B Q4_0 artifacts (about 19 GB each). Crucially, the custom 27B entry advertises **completion only**; the official Qwen3.8 package advertises tools, thinking and vision. That discrepancy warrants checking artifact provenance, template and parser compatibility. It does **not** establish that its underlying model cannot use tools. Custom names are not reliable upstream identity evidence. [Official package capabilities](https://ollama.com/library/qwen3.8)

The machine can plausibly test several substantial quantized models individually. Available total RAM does not establish usable GPU allocation, sustained latency, sufficient context memory or successful application building. Those remain experiments.

## Small sequential shortlist

Start with a credible builder, rather than requiring the smallest model to pass before testing larger ones. Use one candidate at a time. Listed GB values are the registry's rounded download sizes, **not peak RAM**. Short digests identify the inspected manifests; capture full digest, template, runtime and settings when acquiring an artifact because tags can move.

| Proposed order | Exact downloadable Ollama tag; inspected digest | Why test it / hypothesis |
| --- | --- | --- |
| 1 | `qwen3-coder:30b-a3b-q4_K_M`; `06c1097efce0`; 19 GB | Purpose-trained coding agent, 30B total/3.3B active parameters. Tests whether a coding-focused MoE can complete the whole small-product loop with practical resource use. [Artifact](https://ollama.com/library/qwen3-coder/tags), [upstream card](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct). |
| 2 | `qwen3.8:27b-q4_K_M`; `25b843619e94`; 18 GB | Dense generalist alternative with agentic and visual capabilities. Tests whether broader reasoning and environment feedback outweigh heavier per-token computation. Use the explicit non-MTP tag initially; compare MTP separately. [Artifacts](https://ollama.com/library/qwen3.8/tags), [upstream card](https://huggingface.co/Qwen/Qwen3.8-27B). |
| 3 | `devstral-small-2:24b-instruct-2512-q4_K_M`; `24277f07f62d`; 15 GB | Independent model family designed for software agents: tests whether failures are Qwen-specific or environment-wide. [Artifacts](https://ollama.com/library/devstral-small-2/tags), [Mistral release, December 9, 2025](https://mistral.ai/news/devstral-2-vibe-cli/). |
| 4 | `qwen3.5:9b-q4_K_M`; `6488c96fa5fa`; 6.6 GB | Smaller generalist: tests whether suitable equipment and context make lower memory use competitive on completed work. Compare the already installed 4B as a cheap additional baseline, without letting its failure veto local feasibility. [Artifacts](https://ollama.com/library/qwen3.5/tags), [upstream card](https://huggingface.co/Qwen/Qwen3.5-9B). |

These upstream cards identify Apache-2.0 licensing; preserve applicable license/attribution requirements. Research order is a recommendation for the next decision, not a benchmark-derived winner. These four downloads total roughly 59 GB before caches and existing weights; sequential acquisition avoids accumulating unneeded variants.

## Alternatives and exclusions

- **Qwen3-Coder-Next:** a later capacity stretch, not the first dependency. The 80B/3B-active architecture is coding-focused, but `qwen3-coder-next:q4_K_M` is **52 GB**, digest `ca06e9e4087c`; Q8 is 85 GB. The Q4 artifact leaves narrow headroom on this host after OS, applications and context state. Active parameter count is not resident weight size. Test only after a measured memory budget; a smaller quantization would be a separately qualified artifact. [Upstream report, March 2026](https://arxiv.org/abs/2603.00729), [artifacts](https://ollama.com/library/qwen3-coder-next/tags).
- **Nemotron 3.5 Lightning 30B-A3B:** retain as an architectural alternative after tracing the installed conversion. NVIDIA's August 11, 2026 release offers hybrid MoE/Mamba/attention and tool-use recipes under OpenMDW-1.1. Its published NVFP4 recipes target NVIDIA hardware; they do not prove Apple Metal compatibility or the installed GGUF conversion's fidelity. Do not copy DGX Spark throughput or 1M-context claims onto this Mac. [NVIDIA model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4).
- Exclude full-precision 30B as an initial configuration: its 61 GB artifact leaves inadequate practical headroom. Exclude Qwen3-Coder 480B (290 GB Q4) from this host's ordinary trials. Higher precision of a promising smaller model is a better targeted follow-up than starting with enormous weights. [Artifact sizes](https://ollama.com/library/qwen3-coder/tags).

## Configuration is part of the candidate

**Tool calling:** verify a real file-read/edit/execute/result-return round trip before an extended task. A `tools` label proves packaging intent, not correct multi-turn behavior. The server's chat template and parser must agree with the model and client. llama.cpp documents template-dependent native/generic tool formats and `--jinja`; switching engines without checking that contract can create a false model failure. [llama.cpp function calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)

**Context:** explicitly set and observe allocated context; do not assume the advertised maximum is active or useful. Ollama recommends at least 64K for coding agents, but increasing context costs memory. Start with a measured bounded configuration and compare larger context only when the task warrants it. Devstral has a source discrepancy: Mistral describes 256K, whereas Ollama lists 384K. Treat the higher value as unverified for these trials. [Ollama context guidance](https://docs.ollama.com/context-length), [Mistral](https://mistral.ai/news/devstral-2-vibe-cli/), [registry](https://ollama.com/library/devstral-small-2/tags)

**Memory and latency:** hold concurrency at one for initial comparisons. Record actual peak memory, swap pressure, GPU/CPU split, prompt ingestion, generation time and complete-task time. Parallel requests multiply context allocation; cache quantization can reduce memory but introduces another quality variable. Test Q8 weights or cache changes only against a specific observed failure or bottleneck. [Ollama memory/concurrency guidance](https://docs.ollama.com/faq)

## What remains unknown

No candidate has earned a local proof here. Published evaluations justify trying candidates, not claiming autonomous product delivery: Qwen3.8's card itself describes particular harnesses, sampling, time limits and multiple attempts. Our quantization, hardware and work differ. [Evaluation details](https://huggingface.co/Qwen/Qwen3.8-27B)

The next decision must settle task/time budgets, acceptable assistance, repeat trials on fresh tasks, what counts as usable delivery, and the research stopping point. Before execution, also resolve installed-artifact provenance, exact engine/template support, effective GPU memory limit and storage ownership. Judge **usable outcomes per elapsed hour, with repair and assistance included**. Failure of this bounded pool would mean local viability remains unproven under the tested conditions; it cannot establish that all present or future local models are impossible.
