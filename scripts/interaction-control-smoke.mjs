// Private IPC fixtures only: no real daemon, Agent, account, credentials or GUI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

if (process.platform === "win32") {
  console.log("SKIP: this fixture uses Unix sockets");
  process.exit(0);
}
const source = path.resolve(process.argv[2] ?? ".askhuman-dev/bin/AskHuman");
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-pause-")));
const home = path.join(temp, "user"), state = path.join(temp, "state");
fs.mkdirSync(home); fs.mkdirSync(state);
const binary = path.join(temp, "AskHuman");
fs.copyFileSync(source, binary); fs.chmodSync(binary, 0o700);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(ASKHUMAN_|CODEX_|CLAUDE_|CURSOR_|GROK_|PI_)/.test(key)) delete env[key];
}
Object.assign(env, { HOME: home, ASKHUMAN_HOME: state, ASKHUMAN_NO_KEYCHAIN: "1", GIT_CONFIG_GLOBAL: path.join(temp, "gitconfig") });
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "");
const children = [], sockets = new Set(), submissions = [];
const server = net.createServer(socket => {
  sockets.add(socket); socket.on("close", () => sockets.delete(socket));
  createInterface({ input: socket }).on("line", line => {
    const message = JSON.parse(line);
    if (message.type === "hello") socket.write(JSON.stringify({ type: "helloAck", protocolVersion: 4, daemonVersion: "0.16.0", status: "ok" }) + "\n");
    else if (["submit", "submitConfirm"].includes(message.type)) submissions.push({ message, socket });
  });
});
await new Promise(resolve => server.listen(path.join(state, "daemon.sock"), resolve));

function run(args, input) {
  const out = spawnSync(binary, args, { env, cwd: temp, input, encoding: "utf8", timeout: 8000 });
  assert.equal(out.error, undefined, String(out.error));
  return out;
}
function control(action) { const out = run(["interaction", action]); assert.equal(out.status, 0, out.stderr); return out.stdout; }
function start(args, input) {
  const child = spawn(binary, args, { env, cwd: temp, stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
  if (input !== undefined) child.stdin.end(input);
  const result = new Promise(resolve => child.on("exit", code => resolve({ code, stdout, stderr })));
  return { child, result };
}
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "fixture timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => timer = setTimeout(() => reject(new Error("response timed out")), 8000))]); }
  finally { clearTimeout(timer); }
}

try {
  const waiting = start(["pending question", "-o", "continue"]);
  await until(() => submissions.length === 1);
  control("pause");
  const handedBack = await bounded(waiting.result);
  assert.equal(handedBack.code, 0, handedBack.stderr);
  assert.match(handedBack.stdout, /AskHuman is paused/);
  assert.match(handedBack.stdout, /pending question/);
  assert.match(handedBack.stdout, /continue/);
  await until(() => submissions[0].socket.destroyed);

  const paused = run(["new question"]);
  assert.equal(paused.status, 0); assert.match(paused.stdout, /new question/);
  assert.equal(submissions.length, 1, "paused asks must not submit");
  const json = run(["no synthetic answer", "--output", "json"]);
  assert.equal(json.status, 3); assert.equal(json.stdout, "");
  assert.equal(run(["__permission-hook", "claude"], "{}").stdout, "", "pause must not grant or deny permission");

  assert.equal(run(["todo", "add", "--auto", "must stay queued"]).status, 0);
  const queue = fs.readFileSync(path.join(state, "state/todos.json"), "utf8");
  assert.match(run(["--whats-next"]).stdout, /AskHuman is paused/);
  assert.equal(fs.readFileSync(path.join(state, "state/todos.json"), "utf8"), queue);

  // Existing native sessions learn both transitions on their next user prompt.
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { askhuman: { command: binary, args: ["mcp"] } } }));
  const hookInput = JSON.stringify({ session_id: randomUUID(), cwd: temp });
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex/config.toml"), `[mcp_servers.askhuman]\ncommand = "${binary}"\nargs = ["mcp"]\n`);
  for (const action of ["pause", "resume"]) {
    control(action);
    for (const agent of ["claude", "codex"]) {
      const hook = JSON.parse(run(["__context-recovery-hook", agent, "interaction-status"], hookInput).stdout);
      assert.match(hook.hookSpecificOutput.additionalContext, action === "pause" ? /has paused AskHuman/ : /interaction is active/);
    }
  }

  const permissionBefore = submissions.length;
  const permission = start(["__permission-hook", "claude"], JSON.stringify({
    session_id: randomUUID(), cwd: temp, permission_mode: "default", hook_event_name: "PermissionRequest",
    tool_name: "Bash", tool_input: { command: "git status" },
  }));
  await until(() => submissions.length > permissionBefore);
  assert.equal(submissions.at(-1).message.type, "submitConfirm");
  control("pause");
  const nativeApproval = await bounded(permission.result);
  assert.equal(nativeApproval.code, 0); assert.equal(nativeApproval.stdout, "");
  await until(() => submissions.at(-1).socket.destroyed);
  control("resume");

  const mcp = start(["mcp"]), pending = new Map();
  createInterface({ input: mcp.child.stdout }).on("line", line => {
    const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id);
  });
  let id = 0;
  const call = (method, params) => bounded(new Promise(resolve => {
    const next = ++id; pending.set(next, resolve); mcp.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n");
  }));
  const init = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pause-fixture", version: "1" } });
  assert.ok(init.result, JSON.stringify(init));
  mcp.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const native = await call("tools/list", {});
  assert.ok(native.result.tools.some(tool => tool.name === "ask"));
  const before = submissions.length;
  const answer = call("tools/call", { name: "ask", arguments: { message: "MCP pending question" }, _meta: { threadId: randomUUID() } });
  await until(() => submissions.length > before);
  control("pause");
  const result = await answer;
  assert.ok(!result.result.isError, JSON.stringify(result));
  assert.match(JSON.stringify(result.result), /MCP pending question/);
  assert.match(JSON.stringify(result.result), /AskHuman is paused/);
  await until(() => submissions.at(-1).socket.destroyed);
  mcp.child.stdin.end(); await bounded(mcp.result);
  console.log("PASS: in-flight CLI/MCP handback, native hook transitions, no fabricated JSON/approval, no auto-todo dequeue");
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
