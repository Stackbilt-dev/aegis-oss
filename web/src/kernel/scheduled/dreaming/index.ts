// Dreaming phase module barrel export
export { fetchConversationThreads, extractFacts, processFacts, type DreamingResult } from './facts.js';
export { processTaskProposals } from './task-proposals.js';
export { triageAgendaToIssues } from './agenda-triage.js';
export { extractPersonaDimensions } from './persona.js';
export { runPatternSynthesis } from './pattern-synthesis.js';
export { runSymbolicReflection } from './symbolic.js';
export { askWorkersAiOrGroq, parseJsonResponse } from './llm.js';
