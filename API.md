# Undercity API Reference

## Output Module (`src/output.ts`)

### Output Configuration

#### `configureOutput(config: Partial<OutputConfig>): void`
Configure the output system.

**Parameters:**
- `config`: Partial configuration object
  - `mode`: (optional) Output mode ('human' or 'agent')
  - `verbose`: (optional) Enable verbose logging

**Example:**
```typescript
configureOutput({ mode: 'human', verbose: true });
```

#### `getOutputMode(): OutputMode`
Get the current output mode.

**Returns:** Current output mode ('human' or 'agent')

#### `isHumanMode(): boolean`
Check if human mode is active.

**Returns:** `true` if in human mode, `false` otherwise

### Output Functions

#### `info(message: string, data?: Record<string, unknown>): void`
Output an informational message.

**Parameters:**
- `message`: Descriptive message
- `data`: (optional) Additional context data

#### `success(message: string, data?: Record<string, unknown>): void`
Output a success message.

**Parameters:**
- `message`: Success description
- `data`: (optional) Additional context data

#### `error(message: string, data?: Record<string, unknown>): void`
Output an error message.

**Parameters:**
- `message`: Error description
- `data`: (optional) Error details

#### `warning(message: string, data?: Record<string, unknown>): void`
Output a warning message.

**Parameters:**
- `message`: Warning description
- `data`: (optional) Warning details

#### `progress(message: string, state?: ProgressState, data?: Record<string, unknown>): void`
Output a progress update.

**Parameters:**
- `message`: Progress description
- `state`: (optional) Progress state with current/total values
- `data`: (optional) Additional progress data

#### `status(message: string, data?: Record<string, unknown>): void`
Output a status message.

**Parameters:**
- `message`: Status description
- `data`: (optional) Status details

#### `taskStart(taskId: string, description: string, data?: Record<string, unknown>): void`
Output a task start notification.

**Parameters:**
- `taskId`: Unique task identifier
- `description`: Task description
- `data`: (optional) Task start details

#### `taskComplete(taskId: string, message: string, data?: Record<string, unknown>): void`
Output a task completion notification.

**Parameters:**
- `taskId`: Unique task identifier
- `message`: Completion message
- `data`: (optional) Completion details

#### `taskFailed(taskId: string, message: string, errorDetails?: string, data?: Record<string, unknown>): void`
Output a task failure notification.

**Parameters:**
- `taskId`: Unique task identifier
- `message`: Failure message
- `errorDetails`: (optional) Detailed error information
- `data`: (optional) Failure context

#### `metrics(message: string, data: Record<string, unknown>): void`
Output metrics/statistics.

**Parameters:**
- `message`: Metrics description
- `data`: Metrics data

#### `debug(message: string, data?: Record<string, unknown>): void`
Output debug information (only in verbose mode).

**Parameters:**
- `message`: Debug message
- `data`: (optional) Debug details

### Human-Only Functions

#### `header(title: string, subtitle?: string): void`
Print a header/banner (human mode only).

**Parameters:**
- `title`: Main title
- `subtitle`: (optional) Subtitle

#### `section(title: string): void`
Print a section divider (human mode only).

**Parameters:**
- `title`: Section title

#### `summary(title: string, items: Array<{ label: string; value: string | number; status?: "good" | "bad" | "neutral" }>): void`
Print a summary block.

**Parameters:**
- `title`: Summary title
- `items`: Array of summary items with labels, values, and optional status

#### `keyValue(key: string, value: string | number | boolean): void`
Print a simple key-value pair.

**Parameters:**
- `key`: Label for the value
- `value`: The value to display

#### `list(items: string[], prefix?: string): void`
Print a list of items.

**Parameters:**
- `items`: Array of items to list
- `prefix`: (optional) Custom list item prefix (defaults to "•")

### Progress Tracking

#### `createProgressTracker(total: number, label: string): ProgressTracker`
Create a progress tracker for batch operations.

**Parameters:**
- `total`: Total number of items to track
- `label`: Description of the tracked operation

**Returns:** A `ProgressTracker` instance with methods to track progress

### Compatibility

#### `compat.log(message: string): void`
Wrap legacy chalk.* calls to work with both modes.

**Parameters:**
- `message`: Formatted message (typically with chalk coloring)

## Types

### `OutputMode`
```typescript
type OutputMode = "human" | "agent";
```

### `OutputEvent`
```typescript
interface OutputEvent {
  type: "info" | "success" | "error" | "warning" | "progress" | "status" | "task_start" | "task_complete" | "task_failed" | "metrics" | "debug";
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}
```

### `ProgressState`
```typescript
interface ProgressState {
  current: number;
  total: number;
  label: string;
}
```