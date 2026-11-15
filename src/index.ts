/**
 * tdepend: executable architecture contracts for TypeScript.
 *
 * The public surface is the high-level functions below plus their types;
 * presets come from `tdepend/presets`.
 * Discovery, resolution and graph helpers stay internal.
 */

export { analyze } from './api/analyze';
export type { AnalyzeOptions } from './api/analyze';

export { check } from './api/check';
export type { CheckOptions, CheckReport } from './api/check';

export { init } from './api/init';
export type { InitOptions, InitResult } from './api/init';

export { explainFile } from './api/explain';
export type { ExplainRow } from './api/explain';

export { exportToFile } from './api/export';

export { toSerializable } from './api/serialization';

export type { BaselineEntry, BaselineFile } from './baseline/baseline';
export type { Cycle } from './cycles/findCycles';
export type { Metrics } from './metrics/computeMetrics';
export type { EdgeKind, LoadReason } from './parser/types';
export type { Preset } from './presets/definePreset';
export type { RuleConfig, Violation, ViolationTarget } from './rules/types';
export type { ResolutionClass } from './resolver/types';

export type {
  AnalysisResult,
  SerializableEdge,
  SerializableReport,
  SerializableResult,
  SerializableSite,
  SerializableSiteLocation,
  SerializableUnsupported,
} from './types/api';
