import { z } from 'zod';

import type { Assignment, CoverageConfig, GroupGraph } from '../components/types';
import type { CycleCache, CycleHop, CycleLevel } from '../cycles/findCycles';
import type { SiteRecord } from '../graph/buildFileGraph';
import type { FileGraph } from '../graph/fileGraph';
import type { ImportSite } from '../parser/types';
import type { ProjectContext } from '../project/types';
import type { SymbolIndex } from '../symbols/types';

// One schema per rule type. The config loader validates `rules` with it, and
// the types below are inferred from it, so the two can never disagree.

const severitySchema = z.enum(['error', 'warn', 'off']);
const globsSchema = z.array(z.string());
const edgeKindSchema = z.enum(['static', 'type', 're-export', 'dynamic', 'require', 'side-effect']);

const targetSelectorSchema = z
  .strictObject({ files: globsSchema.optional(), modules: globsSchema.optional() })
  .refine((selector) => selector.files !== undefined || selector.modules !== undefined, {
    message: 'a target selector needs `files`, `modules` or both',
  });

const ruleId = z.string().min(1);

const forbiddenSchema = z.strictObject({
  type: z.literal('forbidden'),
  id: ruleId,
  severity: severitySchema.optional(),
  message: z.string(),
  from: globsSchema,
  to: z.union([targetSelectorSchema, globsSchema]),
  exceptFrom: globsSchema.optional(),
  exceptTo: targetSelectorSchema.optional(),
  kinds: z.array(edgeKindSchema).optional(),
  runtimeOnly: z.boolean().optional(),
});

const layersSchema = z
  .strictObject({
    type: z.literal('layers'),
    id: ruleId,
    severity: severitySchema.optional(),
    message: z.string().optional(),
    layers: z.record(z.string(), globsSchema),
    disallow: z.record(
      z.string(),
      z.array(z.strictObject({ layer: z.string(), message: z.string().optional() })),
    ),
  })
  .superRefine((rule, issues) => {
    const declared = new Set(Object.keys(rule.layers));
    for (const [from, pairs] of Object.entries(rule.disallow)) {
      for (const name of [from, ...pairs.map((pair) => pair.layer)]) {
        if (!declared.has(name)) {
          issues.addIssue({
            code: 'custom',
            message: `layer \`${name}\` is not declared in \`layers\``,
          });
        }
      }
    }
  });

const privateSchema = z
  .strictObject({
    type: z.literal('private'),
    id: ruleId,
    severity: severitySchema.optional(),
    message: z.string(),
    paths: globsSchema.optional(),
    public: globsSchema.optional(),
    exceptFrom: globsSchema.optional(),
  })
  .refine((rule) => (rule.paths === undefined) !== (rule.public === undefined), {
    message: 'a private rule needs exactly one of `paths` or `public`',
  });

const noCyclesSchema = z.strictObject({
  type: z.literal('no-cycles'),
  id: ruleId,
  severity: severitySchema.optional(),
  message: z.string().optional(),
  level: z.enum(['file', 'component', 'package']),
  ignoreTypeOnly: z.boolean().optional(),
  ignoreLazyImports: z.boolean().optional(),
});

// `{ id, severity }` changes the severity of a preset rule with that id.
const overrideSchema = z.strictObject({ id: ruleId, severity: severitySchema });

export const ruleDefinitionSchema = z.discriminatedUnion('type', [
  forbiddenSchema,
  layersSchema,
  privateSchema,
  noCyclesSchema,
]);

export const ruleConfigSchema = z.union([ruleDefinitionSchema, overrideSchema]);

export type Severity = z.infer<typeof severitySchema>;
export type TargetSelector = z.infer<typeof targetSelectorSchema>;
export type ForbiddenRule = z.infer<typeof forbiddenSchema>;
export type LayersRule = z.infer<typeof layersSchema>;
export type PrivateRule = z.infer<typeof privateSchema>;
export type NoCyclesRule = z.infer<typeof noCyclesSchema>;
export type RuleOverride = z.infer<typeof overrideSchema>;
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;
export type RuleConfig = z.infer<typeof ruleConfigSchema>;

export type ViolationKind = 'import' | 'cycle' | 'coverage';

export type ViolationTarget = { file: string } | { module: string; workspace?: boolean };

export type SiteData = Omit<ImportSite, 'node'>;

export interface WitnessHop extends Omit<CycleHop, 'site'> {
  site: SiteData;
}

export interface CycleWitness {
  level: CycleLevel;
  members: string[];
  hops: WitnessHop[];
  optimal: boolean;
}

// Import and cycle findings have `to` and `site`; coverage has neither.
export interface Violation {
  kind: ViolationKind;
  ruleId: string;
  projectId: string;
  severity: 'error' | 'warn';
  message: string;
  from: string;
  to?: ViolationTarget;
  site?: SiteData;
  witness?: CycleWitness;
  identity: unknown[];
  fingerprint: string;
}

export type ViolationDraft = Omit<Violation, 'identity' | 'fingerprint'>;

// A user rule has repository scope; a preset rule has one instance per project
// that activates the preset, scoped to the files whose nearest project that is.
// The scope is explicit because the root project's id is also the repository's.
export interface RuleInstance {
  rule: RuleDefinition;
  projectId: string;
  scope: 'repo' | 'project';
  origin: 'user' | 'preset';
}

export interface RuleInput {
  ctx: ProjectContext;
  graph: FileGraph;
  sites: SiteRecord[];
  assignment: Assignment;
  groups: { component: GroupGraph; package?: GroupGraph };
  index: SymbolIndex;
  coverage?: CoverageConfig;
  cycleCache: CycleCache;
}

export interface RuleEvaluation {
  violations: Violation[];
  warnings: string[];
  instances: RuleInstance[];
}

export const REPO_SCOPE = 'proj:(repo)';
