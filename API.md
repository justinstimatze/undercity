# Undercity API Reference

## Semantic Analyzer (`src/semantic-analyzer/analyzer.ts`)

### `SemanticAnalyzer` Class

#### `analyze(options: AnalyzerOptions): Promise<SemanticReport>`
- **Description**: Performs a comprehensive semantic analysis of files in a project
- **Parameters**:
  - `options`: Configuration for analysis
    - `rootDir`: Root directory to analyze
    - `include?`: Optional glob patterns for files to include (default: `["src/**/*.ts", ".claude/**/*.md", "*.md", "package.json"]`)
    - `exclude?`: Optional glob patterns to exclude (default excludes node_modules, dist, tests, coverage)
- **Returns**: A `SemanticReport` containing:
  - File analyses
  - Redundancy detection
  - Recommended actions
  - Global metrics
- **Errors**:
  - Silently skips files that cannot be read
- **Example Usage**:
  ```typescript
  const analyzer = new SemanticAnalyzer();
  const report = await analyzer.analyze({
    rootDir: process.cwd(),
    include: ['src/**/*.ts'],
    exclude: ['**/node_modules/**']
  });
  ```

### Types (`src/semantic-analyzer/types.ts`)

#### Key Interfaces

- `SemanticReport`: Comprehensive analysis report
- `FileAnalysis`: Analysis of a single file
  - `path`: File path
  - `type`: File type (code, docs, config, etc.)
  - `tokens`: Number of tokens
  - `facts`: Number of semantic facts
  - `density`: Semantic density (facts per 1000 tokens)
  - `issues`: Detected issues in the file

- `Issue`: Represents a potential improvement or problem
  - `type`: Issue classification (e.g., redundant_comment, unclear_naming)
  - `severity`: Low, medium, or high
  - `line`: Optional line number
  - `message`: Descriptive text

- `Action`: Recommended improvement
  - `priority`: Low, medium, or high
  - `type`: Action type (rename_symbol, remove_lines, etc.)
  - `file`: Target file path
  - `description`: Human-readable action description

## Future Sections
- More APIs from other target files will be added in subsequent updates