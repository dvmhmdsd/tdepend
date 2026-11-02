/**
 * tdepend: executable architecture contracts for TypeScript.
 *
 * The public surface is the four high-level functions below plus their types.
 * Discovery, resolution and graph helpers stay internal.
 */

export { analyze } from './api/analyze';
export type { AnalyzeOptions } from './api/analyze';

export { explainFile } from './api/explain';
export type { ExplainRow } from './api/explain';

export { exportToFile } from './api/export';

export { toSerializable } from './api/serialization';

export type { EdgeKind, LoadReason } from './parser/types';
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
