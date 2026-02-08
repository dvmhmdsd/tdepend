# TDepend Examples

This directory contains examples demonstrating various ways to use tdepend as a library.

## Running the Examples

All examples are written in TypeScript and can be run using `ts-node`:

```bash
# Install ts-node if you haven't already
npm install -g ts-node

# Run an example
ts-node examples/basic-usage.ts
```

Or compile and run with Node.js:

```bash
# Compile TypeScript
npx tsc examples/basic-usage.ts --outDir examples/dist --module commonjs --esModuleInterop

# Run with Node.js
node examples/dist/basic-usage.js
```

## Available Examples

### 1. basic-usage.ts

**Purpose:** Demonstrates the simplest way to use tdepend programmatically.

**What it shows:**
- Analyzing a project with `analyze()`
- Accessing analysis results (modules, metrics, cycles)
- Finding high-coupling modules
- Identifying modules in "Zone of Pain"
- Checking for threshold violations

**Use case:** Quick analysis scripts, learning the API basics

### 2. ci-check.ts

**Purpose:** Shows how to integrate tdepend into CI/CD pipelines.

**What it shows:**
- Running analysis with strict settings
- Exporting reports as CI artifacts
- Custom quality gates (average distance check)
- Proper exit codes for CI tools
- Error reporting for violations

**Use case:** GitHub Actions, GitLab CI, Jenkins, or any CI/CD system

**Example GitHub Actions workflow:**
```yaml
- name: Architecture Quality Check
  run: |
    npm install tdepend
    ts-node examples/ci-check.ts
```

### 3. architectural-tools-integration.ts

**Purpose:** Demonstrates integration with other architectural tools.

**What it shows:**
- Exporting serializable analysis data
- Creating dependency maps for external tools
- Generating metrics summaries for dashboards
- Custom architectural rule validation
- Different export formats for different consumers

**Use case:** Integration with ts-arch, dependency-cruiser, custom dashboards

**Tools that can consume tdepend data:**
- **ts-arch** - Use dependency graph for rule validation
- **dependency-cruiser** - Cross-validate dependency rules
- **Custom dashboards** - Visualize metrics over time
- **ArchUnit-style tools** - Enforce architectural constraints

## Common Patterns

### Pattern 1: Analyze and Export

```typescript
import { analyze, exportToFile } from 'tdepend';

const result = await analyze({ rootDir: 'src' });
await exportToFile(result, 'analysis.json');
```

### Pattern 2: Custom Quality Gates

```typescript
import { analyze } from 'tdepend';

const result = await analyze({ rootDir: 'src' });

// Fail if any module has distance > 0.8
const badModules = result.metrics.filter(m => m.distance > 0.8);
if (badModules.length > 0) {
  console.error('Quality gate failed');
  process.exit(1);
}
```

### Pattern 3: Combining with Config File

```typescript
import { analyze, loadConfig } from 'tdepend';

// Load config from file
const config = loadConfig('custom-config.json');

// Override specific settings
const result = await analyze({
  ...config,
  failOnCycle: true,
});
```

### Pattern 4: Working with the Dependency Graph

```typescript
import { analyze } from 'tdepend';

const result = await analyze({ rootDir: 'src' });

// Find all dependents of a specific module
const targetModule = '/path/to/module.ts';
const node = result.graph.getNode(targetModule);

if (node) {
  console.log('Direct dependents:', Array.from(node.dependents));
  console.log('Direct dependencies:', Array.from(node.dependencies));
}
```

### Pattern 5: Serialization for External Tools

```typescript
import { analyze, toSerializable } from 'tdepend';

const result = await analyze({ rootDir: 'src' });
const serialized = toSerializable(result);

// Now serialized can be safely JSON.stringify'd
// All Sets are converted to Arrays
// Cycles are normalized with unique IDs
const json = JSON.stringify(serialized, null, 2);
```

## Integration Examples

### With ts-arch

```typescript
import { analyze } from 'tdepend';
// Assuming ts-arch or similar library

const result = await analyze({ rootDir: 'src' });

// Use tdepend's dependency graph for ts-arch rules
const dependencies = result.modules.map(m => ({
  file: m.filePath,
  imports: m.imports,
}));

// Apply ts-arch rules using the dependency data
// tsArch.checkRule('controllers should not depend on views', dependencies);
```

### With Custom Dashboard

```typescript
import { analyze } from 'tdepend';
import { sendToDashboard } from './dashboard-api';

const result = await analyze({ rootDir: 'src' });

await sendToDashboard({
  timestamp: new Date(),
  metrics: {
    totalModules: result.modules.length,
    avgDistance: result.metrics.reduce((sum, m) => sum + m.distance, 0) / result.metrics.length,
    cycles: result.cycles.length,
  },
});
```

## Tips

1. **Performance**: For large projects, consider filtering the include/exclude patterns to analyze only the relevant parts.

2. **CI Integration**: Always export the full analysis report as a CI artifact for debugging.

3. **Custom Thresholds**: Adjust distance thresholds based on your project's needs. Start with 0.6 and tune based on results.

4. **Cycle Detection**: Enable `failOnCycle` in CI to prevent circular dependencies from being merged.

5. **Combining Tools**: Use tdepend for metrics and ts-arch/dependency-cruiser for rule enforcement - they complement each other well.

## Need More Examples?

Check the [main README](../README.md) for additional documentation or open an issue on GitHub.
