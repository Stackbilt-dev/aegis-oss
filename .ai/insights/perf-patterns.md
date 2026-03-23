# Performance Patterns

Performance wins — optimizations that measurably improved latency, cost, or throughput.

---

### Complexity-aware model routing for composite executor
- **Type**: perf_win
- **Origin**: aegis-oss@composite-executor
- **Applicable to**: [aegis-oss]
- **Confidence**: 0.75
- **Impact**: deployed
- **Keywords**: composite executor, model routing, complexity, groq, gpt_oss, cost, latency

The composite executor originally routed all subtasks to the same model regardless of complexity. Switching to complexity-aware routing — `bizops_mutate` operations go to `gpt_oss` (higher reliability for structured mutations), while simple queries stay on Groq (lower latency, lower cost) — reduced both cost and failure rate. The single-subtask fast-path also eliminates orchestration overhead when only one tool is needed.

### Hybrid recall with Vectorize semantic search
- **Type**: perf_win
- **Origin**: memory-worker@v0.3.0
- **Applicable to**: [aegis-oss, memory-worker]
- **Confidence**: 0.7
- **Impact**: deployed
- **Keywords**: memory, vectorize, bge-base, semantic search, hybrid recall, 768-dim, cosine

Pure keyword recall missed semantically related memories. Pure vector search missed exact-match requirements. Hybrid recall (BGE-base-en-v1.5, 768-dim, cosine similarity) with keyword intersection gives the best of both: semantic breadth with keyword precision. The 31% context overlap / 60% keyword overlap numbers from early dual-read testing confirmed the approaches are complementary, not redundant.
