/**
 * TDepend - TypeScript Dependency Analysis Library
 *
 * A JDepend-inspired dependency analysis tool for TypeScript projects.
 * Computes architectural metrics and detects dependency issues.
 *
 * @packageDocumentation
 */

// High-level API - Primary interface for library users
export { analyze, analyzeWithConfig } from './api/analyze';
export type { AnalyzeOptions } from './api/analyze';

export { exportToFile, exportToJson } from './api/export';
export type { ExportOptions } from './api/export';

export { toSerializable } from './api/serialization';

// Core building blocks - For advanced users who want fine-grained control
export { DependencyGraph } from './graph/dependencyGraph';
export { detectCycles } from './graph/cycleDetector';
export { computeAllMetrics } from './metrics';
export { parseProject, parseFile } from './parser/tsParser';
export { scanFiles } from './parser/fileScanner';
export { loadConfig } from './config/loadConfig';
export { generateReport, formatJsonOutput } from './analysis/reporter';

// Type exports - Essential for TypeScript users
export type { ParsedModule, ParsedClass, ParsedNamespace } from './types/parser';
export type { DependencyNode, ModuleMetrics } from './types/graph';
export type { AnalysisReport } from './analysis/reporter';
export type { TDependConfig } from './config/schema';
export type {
  AnalysisResult,
  SerializableAnalysisResult,
  SerializableDependencyGraph,
  SerializableDependencyNode,
  SerializableCycle,
} from './types/api';

// Configuration - Useful for customization
export { defaultConfig } from './config/schema';
