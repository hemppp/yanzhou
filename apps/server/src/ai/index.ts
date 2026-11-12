// ============================================================
// AI 模块统一导出
// ============================================================

// ---- Provider ----
export {
  type AIProvider,
  type AIProviderType,
  type AIConfig,
  type ChatMessage,
  type ChatOptions,
  AIProviderError,
  getProvider,
  getAIConfig,
  setConfigLoader,
  clearConfigCache,
  clearProviderCache,
} from './providers/provider-factory.js';

// ---- Agents ----
export {
  type ScannerInput,
  type ScannerResult,
  type ScannerEntity,
  type ScannerEvent,
  type ScannerStateChange,
  type ScannerForeshadow,
  type ScannerConsistencyIssue,
  runScanner,
  scanChapter,
  type StreamTimelineEvent,
  type StreamEntity,
  type StreamCreditTransaction,
  streamTimelineEvents,
  streamEventsByKeyword,
} from './agents/scanner-agent.js';

export {
  type ConsistencyInput,
  type ConsistencyResult,
  type ConsistencyCheckItem,
  runConsistencyCheck,
  toConsistencyIssues,
} from './agents/consistency-agent.js';

export {
  type StyleInput,
  type StyleResult,
  type StyleProfile,
  type SimplifiedStyleResult,
  runStyleAnalysis,
  runSimplifiedStyleAnalysis,
} from './agents/style-agent.js';

export {
  type RhythmInput,
  type RhythmResult,
  type RhythmMarkDTO,
  runRhythmAnalysis,
} from './agents/rhythm-agent.js';

export {
  type PlotInput,
  type PlotResult,
  type PlotForeshadow,
  type PlotForeshadowRelation,
  runPlotAnalysis,
} from './agents/plot-agent.js';

export {
  type ChatInput,
  type ChatResult,
  runChatAgent,
  runChatAgentSimple,
  runChatAgentSimpleStream,
} from './agents/chat-agent.js';

export {
  type ExtractInput,
  type ExtractResult,
  type ExtractedEntity,
  runExtract,
} from './agents/entity-extract-agent.js';

export {
  type TimelineAnalysisInput,
  type TimelineAnalysisResult,
  type TimelineFlowNode,
  type TimelineFlowEdge,
  runTimelineAnalysis,
} from './agents/timeline-analysis-agent.js';

// ---- Pipeline ----
export {
  type PipelineInput,
  type PipelineResult,
  type PipelineOptions,
  runPipeline,
  runScanPipeline,
  isPipelineSuccess,
} from './pipeline.js';

// ---- Context Builder ----
export {
  type ProjectContext,
  buildProjectContext,
  checkOutlineExists,
} from './context-builder.js';