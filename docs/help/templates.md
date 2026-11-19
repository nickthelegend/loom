# Starter templates from a folder or Git

`loom init --list-templates` lists bundled starters: web, node, library, api, cli, static and python. The API, CLI, static-site and Python starters include small executable tests. Select any starter in New project on web or phone.

In an empty destination directory, run `loom init --template api` or choose another starter. To reuse your own files, run `loom init --template /absolute/path/to/starter` or `loom init --template https://example.com/team/starter.git`.

External templates are copied without their Git history, .loom configuration, dependencies or .env files. Symlinks and special files are refused, and existing files are never overwritten. Template code is not executed or installed. Inspect it before installing dependencies or running it. HTTPS and SSH Git sources are supported; authentication uses your existing Git setup.

`/api/init-templates` lists project starters. `/api/templates` remains the separate prompt-template library.
