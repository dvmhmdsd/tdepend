import { unmatchedGlobs, type RuleContext, type RuleOutcome } from './context';
import { importViolation } from './identity';
import { globMatcher, targetFile } from './selectors';
import type { LayersRule, RuleInstance } from './types';

// Shorthand for forbidden rules between named layers. A file belongs to the
// first listed layer it matches; each disallowed pair reports under the layers
// rule's own id, with the pair's message or else the rule's.
export function evaluateLayers(
  instance: RuleInstance,
  rule: LayersRule,
  context: RuleContext,
): RuleOutcome {
  const names = Object.keys(rule.layers);
  const matchers = names.map((name) => [name, globMatcher(rule.layers[name])] as const);
  const layerOf = (file: string): string | undefined =>
    matchers.find(([, matches]) => matches(file))?.[0];
  const banned = bannedPairs(rule);

  const violations = context.sitesIn(instance.scopeFiles).flatMap((record) => {
    const target = targetFile(record);
    const fromLayer = layerOf(record.file);
    if (target === null || fromLayer === undefined) return [];
    const toLayer = layerOf(target);
    const message = toLayer === undefined ? undefined : banned.get(fromLayer)?.get(toLayer);
    return message === undefined ? [] : [importViolation(instance, record, message)];
  });

  return {
    violations,
    warnings: unmatchedGlobs(
      instance,
      context,
      names.map((name) => [`layers.${name}`, rule.layers[name]]),
    ),
  };
}

// from layer → to layer → message.
function bannedPairs(rule: LayersRule): Map<string, Map<string, string>> {
  const banned = new Map<string, Map<string, string>>();
  for (const [from, pairs] of Object.entries(rule.disallow)) {
    const targets = new Map<string, string>();
    for (const pair of pairs) {
      targets.set(
        pair.layer,
        pair.message ??
          rule.message ??
          `Layer \`${from}\` must not import layer \`${pair.layer}\`.`,
      );
    }
    banned.set(from, targets);
  }
  return banned;
}
