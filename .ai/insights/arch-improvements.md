# Architecture Improvements

Architecture learnings — structural changes that improved maintainability or extensibility.

---

### God object decomposition via directory modules
- **Type**: arch_improvement
- **Origin**: aegis-oss@v1.11.1
- **Applicable to**: [aegis-oss, *]
- **Confidence**: 0.9
- **Impact**: deployed
- **Keywords**: god object, decomposition, module, directory, kernel, memory, scheduled

Large single-file modules (`kernel/memory.ts`, `kernel/scheduled.ts`, `claude.ts`) became unwieldy as features accumulated. Decomposed into directory modules: `kernel/memory/` (index + sub-modules), `kernel/scheduled/` (index + sub-modules), `claude.ts` + `claude-tools.ts`. The key principle: split along responsibility boundaries, keep the barrel export (`index.ts`) as the public API so consumers don't change. This pattern applies universally — any file over ~400 lines that handles multiple concerns is a decomposition candidate.

### Extension over addition design philosophy
- **Type**: arch_improvement
- **Origin**: aegis-oss@core.adf
- **Applicable to**: [*]
- **Confidence**: 0.85
- **Impact**: deployed
- **Keywords**: extension, addition, design philosophy, identity axis, decompose, tarotscript, cross keyword

When faced with new functionality, prefer extending an existing concept's domain over introducing a new concept. Extend along the concept's identity axis; decompose only when identity breaks. Origin: TarotScript `cross` keyword chose pattern matching (extending an existing paradigm) over branching (adding a new control flow concept). This principle has consistently produced more coherent APIs — fewer concepts means lower cognitive load and more predictable behavior for agents and humans alike.
