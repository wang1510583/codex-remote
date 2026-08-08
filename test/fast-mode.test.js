import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CodexAppServer,
  fastServiceTierForModel,
  isFastServiceTier
} from "../src/codex-server.js";

const fastModel = {
  id: "gpt-5.6-sol",
  model: "gpt-5.6-sol",
  serviceTiers: [{
    id: "priority",
    name: "Fast",
    description: "1.5x speed, increased usage"
  }],
  additionalSpeedTiers: ["fast"]
};

test("Fast service tiers use the catalog id while accepting persisted aliases", () => {
  assert.deepEqual(fastServiceTierForModel(fastModel), fastModel.serviceTiers[0]);
  assert.deepEqual(fastServiceTierForModel({
    id: "legacy-model",
    additionalSpeedTiers: ["fast"]
  }), {
    id: "fast",
    name: "Fast",
    description: ""
  });
  assert.equal(fastServiceTierForModel({ id: "standard-model", serviceTiers: [] }), null);
  assert.equal(isFastServiceTier("priority", fastModel.serviceTiers[0]), true);
  assert.equal(isFastServiceTier("fast", fastModel.serviceTiers[0]), true);
  assert.equal(isFastServiceTier(null, fastModel.serviceTiers[0]), false);
});

test("Fast status combines the live thread tier with the persisted config", async () => {
  const server = new CodexAppServer({}, { isRemote: true });
  server.ensureStarted = async () => {};
  server.readThreadSettings = async () => ({
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    serviceTier: "priority"
  });
  server.readConfig = async () => ({
    config: {
      model: "gpt-5.6-sol",
      service_tier: "fast",
      features: { fast_mode: true }
    }
  });
  server.modelOptions = async () => [fastModel];

  const status = await server.fastModeStatus(
    "gpt-5.6-sol",
    "thread-1",
    "/workspace"
  );

  assert.equal(status.model, "gpt-5.6-sol");
  assert.equal(status.supported, true);
  assert.equal(status.enabled, true);
  assert.equal(status.configuredEnabled, true);
  assert.equal(status.serviceTier, "priority");
  assert.equal(status.configuredServiceTier, "fast");
  assert.equal(status.requestServiceTier, "priority");
});

test("Fast mode writes the user default and updates the current thread immediately", async () => {
  const calls = [];
  let configTier = null;
  let threadTier = null;
  const server = new CodexAppServer({}, { isRemote: true });
  server.fastModeStatus = async () => ({
    model: "gpt-5.6-sol",
    supported: true,
    featureEnabled: true,
    enabled: isFastServiceTier(threadTier, fastModel.serviceTiers[0]),
    configuredEnabled: isFastServiceTier(configTier, fastModel.serviceTiers[0]),
    serviceTier: threadTier,
    configuredServiceTier: configTier,
    requestServiceTier: "priority",
    fastTier: fastModel.serviceTiers[0]
  });
  server.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "config/batchWrite") {
      configTier = params.edits[0].value;
      return { status: "ok" };
    }
    throw new Error(`unexpected request: ${method}`);
  };
  server.updateThreadServiceTier = async (threadId, serviceTier, cwd) => {
    calls.push({ method: "thread/settings/update", params: { threadId, serviceTier, cwd } });
    threadTier = serviceTier;
    return serviceTier;
  };

  const enabled = await server.setFastMode(
    true,
    "gpt-5.6-sol",
    "thread-1",
    "/workspace"
  );
  assert.equal(enabled.enabled, true);
  assert.equal(configTier, "fast");
  assert.equal(threadTier, "priority");
  assert.deepEqual(calls[0], {
    method: "config/batchWrite",
    params: {
      edits: [{
        keyPath: "service_tier",
        value: "fast",
        mergeStrategy: "upsert"
      }],
      reloadUserConfig: true
    }
  });
  assert.deepEqual(calls[1], {
    method: "thread/settings/update",
    params: {
      threadId: "thread-1",
      serviceTier: "priority",
      cwd: "/workspace"
    }
  });

  const disabled = await server.setFastMode(
    false,
    "gpt-5.6-sol",
    "thread-1",
    "/workspace"
  );
  assert.equal(disabled.enabled, false);
  assert.equal(configTier, null);
  assert.equal(threadTier, null);
});

test("a failed live Fast update restores the previous persisted default", async () => {
  const writtenTiers = [];
  const server = new CodexAppServer({}, { isRemote: true });
  server.fastModeStatus = async () => ({
    model: "gpt-5.6-sol",
    supported: true,
    featureEnabled: true,
    enabled: false,
    configuredEnabled: false,
    serviceTier: null,
    configuredServiceTier: null,
    requestServiceTier: "priority",
    fastTier: fastModel.serviceTiers[0]
  });
  server.request = async (method, params) => {
    assert.equal(method, "config/batchWrite");
    writtenTiers.push(params.edits[0].value);
    return { status: "ok" };
  };
  server.updateThreadServiceTier = async () => {
    throw new Error("thread update failed");
  };

  await assert.rejects(
    server.setFastMode(true, "gpt-5.6-sol", "thread-1", "/workspace"),
    /thread update failed/
  );
  assert.deepEqual(writtenTiers, ["fast", null]);
});

test("Fast mode refuses models that do not advertise a Fast tier", async () => {
  const server = new CodexAppServer({}, { isRemote: true });
  server.fastModeStatus = async () => ({
    model: "gpt-5.4-mini",
    supported: false,
    featureEnabled: true,
    enabled: false,
    configuredEnabled: false,
    serviceTier: null,
    configuredServiceTier: null,
    requestServiceTier: "",
    fastTier: null
  });
  server.request = async () => {
    throw new Error("config must not be written");
  };

  await assert.rejects(
    server.setFastMode(true, "gpt-5.4-mini", "", "/workspace"),
    /不提供 Fast 服务层/
  );
});

test("the slash panel and local command router expose Fast mode", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const runner = await readFile(new URL("../src/runner.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/remote.html", import.meta.url), "utf8");

  assert.match(source, /command:\s*"\/fast"[\s\S]*?title:\s*"Fast 快速模式"/);
  assert.match(runner, /\/fast on\|off\|status/);
  assert.match(runner, /commandServer\.setFastMode/);
  assert.match(html, /remote\.js\?v=20260809-auto-approval-notifications/);
});
