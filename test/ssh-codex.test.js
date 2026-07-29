import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { connectorSupportsConcurrentAppServers } from "../src/connectors.js";
import { mapWithConcurrency } from "../src/runner.js";
import { parseSshTarget, sshConnectorId } from "../src/ssh.js";
import { SshExecTransport } from "../src/transport/ssh.js";

class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.destroyed = false;
    this.writableEnded = false;
    this.writes = [];
  }

  write(value) {
    this.writes.push(value);
  }

  close() {
    this.destroyed = true;
    this.emit("close", 0);
  }

  end() {
    this.writableEnded = true;
  }
}

test("SSH targets produce stable connector ids and support parallel app-server channels", () => {
  const parsed = parseSshTarget("ssh codex@[2001:db8::1]:2222");
  assert.deepEqual(parsed, {
    username: "codex",
    host: "2001:db8::1",
    port: 2222,
    label: "codex@2001:db8::1:2222"
  });
  const id = sshConnectorId(parsed);
  assert.match(id, /^ssh_[a-f0-9]{20}$/);
  assert.equal(sshConnectorId("codex@[2001:db8::1]:2222"), id);
  assert.equal(connectorSupportsConcurrentAppServers(id), true);
  assert.equal(connectorSupportsConcurrentAppServers("conn_example"), false);
});

test("SSH app-server transport frames JSONL across chunks and writes one line", async () => {
  const channel = new FakeChannel();
  const transport = new SshExecTransport({ openChannel: async () => channel });
  const messages = [];
  transport.onMessage((line) => messages.push(line));
  await transport.start();
  channel.emit("data", Buffer.from('{"id":1}\n{"met'));
  channel.emit("data", Buffer.from('hod":"turn"}\r\n'));
  assert.deepEqual(messages, ['{"id":1}', '{"method":"turn"}']);
  transport.send('{"method":"initialize"}');
  assert.deepEqual(channel.writes, ['{"method":"initialize"}\n']);
  assert.equal(transport.alive, true);
  transport.kill();
  assert.equal(transport.alive, false);
});

test("remote session files can be read concurrently without changing newest-first order", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([40, 5, 20, 1], 3, async (delay) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return delay * 2;
  });
  assert.ok(peak >= 2);
  assert.deepEqual(result, [80, 10, 40, 2]);
});
