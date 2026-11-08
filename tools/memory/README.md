# CodiMD memory MCP server

An MCP server that gives Claude Code the `memory_*` tools for the second brain: memory notes stored in CodiMD and reached through `/api/memory`. It runs on the host with Node 18 or later and has no npm dependencies.

## Setup

1. Sign in to CodiMD, open `/settings/api-tokens`, and create a token.
2. Save the token in a file that only you can read:

   ```sh
   mkdir -p ~/.config/codimd-memory
   printf '{"token": "%s"}\n' 'PASTE_TOKEN' > ~/.config/codimd-memory/config.json
   chmod 600 ~/.config/codimd-memory/config.json
   ```

   The server refuses to start a request if group or others can read this file. `CODIMD_MEMORY_TOKEN` overrides `token`.

3. Register the server for all your projects:

   ```sh
   claude mcp add --scope user codimd-memory -- node /home/paulboul/codimd/tools/memory/mcp.js
   ```

4. Allow the read tools without a prompt by adding them to `permissions.allow` in `~/.claude/settings.json`. Leave the write tools out, so that each write asks for your approval.

   ```json
   "mcp__codimd-memory__memory_index",
   "mcp__codimd-memory__memory_search",
   "mcp__codimd-memory__memory_read"
   ```

## Server address

The client uses the first of these that applies:

1. `CODIMD_URL`, or `serverUrl` in the config file.
2. `http://localhost:3000`, when its memory API answers within 1.5 seconds.
3. The tunnel URL in `https://paulboul1013.github.io/codimd/target.json`, which `./bin/start-public` publishes.

The server keeps the address for its lifetime and looks it up again once after a connection failure.

## Tools

| Tool | Kind | Purpose |
| --- | --- | --- |
| `memory_index` | read | Titles of the global notes and the current project's notes |
| `memory_search` | read | Search by text, scope, type, or archived state |
| `memory_read` | read | One note in full |
| `memory_create` | write | Create a note |
| `memory_update` | write | Replace a note's content |
| `memory_append` | write | Append text to a note |
| `memory_archive` | write | Archive a note instead of deleting it |

The current project is the repo name of the working directory's `origin` remote, or the name of the git top-level directory when there is no remote.
