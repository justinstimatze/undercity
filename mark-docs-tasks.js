import { markTaskComplete } from "./dist/task.js";

const tasks = [
  { id: "task-docs-readme-agent-format", commit: "6e09ecb" },
  { id: "task-docs-api-reference", commit: "4e97be5" },
];

for (const task of tasks) {
  console.log(`Marking ${task.id} as complete (${task.commit})`);
  markTaskComplete(task.id);
}

console.log("Done!");
