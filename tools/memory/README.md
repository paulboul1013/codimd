# CodiMD memory MCP server

An MCP server, a SessionStart hook, and a skill that give Claude Code the second brain: memory notes stored in CodiMD and reached through `/api/memory`. It runs on the host with Node 18 or later and has no npm dependencies.

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

5. Add the SessionStart hook and turn off local auto memory in `~/.claude/settings.json`:

   ```json
   "autoMemoryEnabled": false,
   "hooks": {
     "SessionStart": [
       {
         "hooks": [
           { "type": "command", "command": "node /home/paulboul/codimd/tools/memory/session-start.js" }
         ]
       }
     ]
   }
   ```

6. Install the `second-brain` skill, which tells the agent when to propose a memory and how to write it:

   ```sh
   mkdir -p ~/.claude/skills
   ln -s /home/paulboul/codimd/tools/memory/skill ~/.claude/skills/second-brain
   ```

   Copy the directory instead of linking it if you do not want later edits in this repo to take effect.

## SessionStart hook

`session-start.js` reads the hook input from stdin and uses its `cwd` to find the current project, or the process working directory when the input has none. It prints the titles of the global and project memory notes, at most 50 per scope, and says how many it left out. Claude Code adds this output to the session context.

When the hook cannot load the index, it prints one line that starts with `第二大腦：CodiMD 無法連線` and exits with status 0, so the session still starts. This happens when CodiMD is not reachable, no token is configured, the server rejects the token, or the hook takes longer than 5 seconds. The hook never prints the token.

Run it by hand to see what a session gets:

```sh
echo '{"cwd": "'"$PWD"'"}' | node /home/paulboul/codimd/tools/memory/session-start.js
```

## Server address

The client uses the first of these that applies:

1. `CODIMD_URL`, or `serverUrl` in the config file.
2. `http://localhost:3000`, when its memory API answers within 1.5 seconds.
3. The tunnel URL in `https://paulboul1013.github.io/codimd/target.json`, which `./bin/start-public` publishes.

The MCP server and the hook use the same lookup. The MCP server keeps the address for its lifetime and looks it up again once after a connection failure. A Cloudflare 530 error page, which a stopped tunnel returns, counts as a connection failure. A read also looks the address up again after any other error page that is not a memory API answer. A write does not, because the server may already have applied it.

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

## Import local memory

`import.js` copies the Claude Code memory files in `~/.claude/projects/*/memory/` into memory notes, once. Run it after setup, preview first:

```sh
node tools/memory/import.js --dry-run --offline   # list the files, without a token or server
node tools/memory/import.js --dry-run             # also check which notes already exist
node tools/memory/import.js                       # create the notes
```

- Each file becomes one note with the file's type and the tag `imported`. A type other than `user`, `feedback`, `project`, or `reference` becomes `reference`.
- `user` memories go to `global`. Other memories go to the scope of their project: the git repo the project directory points to, or the directory name when it is not a repo.
- `MEMORY.md` index files and project directories under `/tmp` are skipped.
- The note body ends with `<!-- imported-from: <scope>/<name> -->`. A rerun skips each file whose marker is already in a note, archived notes included. A note with the older `<!-- imported-from: <name> -->` marker counts too when its scope matches.
- `--root <dir>` reads another projects directory.
