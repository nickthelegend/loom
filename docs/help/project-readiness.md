# Project readiness and first prompts

Run `loom ready` in a registered project, or open Project settings on the web and Project tools on the phone. Five checks contribute twenty points each: a test command, agent instructions, a clean Git working tree, an ignore rule for .loom/, and a bounded repository size.

The score is a starting checklist, not a guarantee of quality. Readiness detects a test command without executing it. The size scan excludes Git metadata, Loom state and common dependency directories, and stops at its file/depth limits.

`loom ready --fix` drafts missing AGENTS.md instructions and adds .loom/ to .gitignore. Review the draft. Existing instruction files stay intact. Git state, test setup and large files require your judgment; no commits or deletions happen here.

Empty chats offer five prompts selected from the detected stack and Git state. Tapping a prompt fills the composer so you can edit it before sending.
