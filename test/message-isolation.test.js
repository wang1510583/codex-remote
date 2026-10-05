import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { broadcastRunner, queueConversationSelection, setSelectedRunnerKey } from '../src/runner.js';
import { eventBacklog } from '../src/sse.js';
import { mergeLocalMessageMeta } from '../src/threads.js';

const source = await readFile(new URL('../public/remote.js', import.meta.url), 'utf8');
function fragment(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
function eventHarness() {
  const shown = [];
  const context = {
    state: { threadId: 'B', runtimeId: 'runtime-B', connectorId: '', running: false,
      assistantBubbles: new Map(), snapshotEventSeq: 50, lastEventSeq: 50, completedUnreadThreads: new Set() },
    selectingConversation: false, selectionEvents: [], processedEventSeqs: new Set(),
    upsertAssistantMessage: (content) => shown.push(content), appendMessage: (_role, content) => shown.push(content),
    speakCompletedAssistantMessage() {}, notifyCodexReply() {},
    renderState(data) { shown.push(`state:${data.threadId}`); context.state.threadId = data.threadId; },
  };
  vm.createContext(context);
  vm.runInContext(fragment('function remoteEventSequence', 'function approvalKindLabel'), context);
  vm.runInContext(fragment('function handleRemoteEvent', 'async function resyncEvents'), context);
  return { context, shown };
}

test('local and remote clients reject other-thread replies and state snapshots', () => {
  for (const connectorId of ['', 'remote-host']) {
    const { context, shown } = eventHarness();
    context.state.connectorId = connectorId;
    for (const type of ['message', 'cli_message', 'state', 'status', 'error', 'done']) {
      context.handleRemoteEvent({ type, connectorId, threadId: 'A', role: 'assistant', content: 'wrong', final: true });
    }
    assert.deepEqual(shown, []);
    assert.equal(context.state.threadId, 'B');
    context.handleRemoteEvent({ type: 'message', connectorId, threadId: 'B', role: 'assistant', content: 'correct', final: true });
    assert.deepEqual(shown, ['correct']);
  }
});

test('snapshot floor rejects unseen old replay but accepts later replies including equal text', () => {
  const { context, shown } = eventHarness();
  for (const seq of [48, 50, 51, 51, 52]) {
    context.handleRemoteEvent({ seq, type: 'message', threadId: 'B', role: 'assistant', content: '好的', final: true });
  }
  assert.deepEqual(shown, ['好的', '好的']);
});

test('a new session adopts only its own runtime thread and still receives background completion badges', () => {
  const { context, shown } = eventHarness();
  context.state.threadId = '';
  context.handleRemoteEvent({ type: 'state', threadId: 'A', runtimeId: 'runtime-A' });
  assert.deepEqual(shown, []);
  context.handleRemoteEvent({ type: 'state', threadId: 'B', runtimeId: 'runtime-B' });
  assert.deepEqual(shown, ['state:B']);
  context.handleRemoteEvent({ type: 'thread_completion', threadId: 'A', completedUnread: true });
  assert.equal(context.state.completedUnreadThreads.has('A'), true);
});

test('selection buffers SSE until the newest HTTP response and ignores older responses', async () => {
  const { context, shown } = eventHarness();
  const pending = new Map();
  Object.assign(context, { threadSelectionGeneration: 0, stateLoadGeneration: 0,
    browserVoice: null,
    els: { threadPanel: {} }, request: (_url, options) => new Promise(resolve => pending.set(JSON.parse(options.body).threadId, resolve)) });
  vm.runInContext(fragment('async function requestConversation', 'let externalSessionRefreshTimer'), context);
  const a = context.selectThread('A');
  const b = context.selectThread('B');
  context.handleRemoteEvent({ seq: 51, type: 'state', threadId: 'A' });
  context.handleRemoteEvent({ seq: 52, type: 'message', threadId: 'B', role: 'assistant', content: 'B live reply', final: true });
  assert.deepEqual(shown, []);
  pending.get('B')({ threadId: 'B' }); await b;
  pending.get('A')({ threadId: 'A' }); await a;
  assert.deepEqual(shown, ['state:B', 'B live reply']);
});

test('backend selection commits are serialized and a failed selection does not block the next', async () => {
  const calls = [];
  let release;
  const first = queueConversationSelection('test', async () => { calls.push('A'); await new Promise(r => { release = r; }); throw new Error('not found'); });
  const failure = assert.rejects(first, /not found/);
  const second = queueConversationSelection('test', async () => { calls.push('B'); return 'B'; });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, ['A']);
  release();
  assert.equal(await second, 'B');
  await failure;
  assert.deepEqual(calls, ['A', 'B']);
});

test('runner reply envelopes retain thread/runtime ownership', () => {
  setSelectedRunnerKey('thread:B');
  broadcastRunner({ key: 'thread:B', connectorId: '', state: { threadId: 'B', runtimeId: 'new-B' } },
    { type: 'message', content: 'hi' });
  assert.equal(eventBacklog.at(-1).threadId, 'B');
  assert.equal(eventBacklog.at(-1).runtimeId, 'new-B');
  setSelectedRunnerKey('');
});

test('restoring identical replies keeps per-occurrence stable ids, including a page tail', async () => {
  const previous = [
    { role: 'assistant', content: '✅ 好的', messageId: 'item-1', final: true },
    { role: 'assistant', content: '✅ 好的', messageId: 'item-2', final: true }
  ];
  const rows = previous.map(({ messageId, final, ...row }) => row);
  assert.deepEqual((await mergeLocalMessageMeta('', rows, previous)).map(row => row.messageId), ['item-1', 'item-2']);
  assert.equal((await mergeLocalMessageMeta('', rows.slice(-1), previous))[0].messageId, 'item-2');
});

test('finalizing a streaming reply keeps it before a newer user task', () => {
  const oldContainer = { name: 'old' };
  const userContainer = { name: 'new user' };
  const containers = [oldContainer, userContainer];
  oldContainer.replaceWith = (replacement) => {
    containers.splice(containers.indexOf(replacement), 1);
    containers[containers.indexOf(oldContainer)] = replacement;
  };
  const bubble = { isConnected: true, dataset: { messageId: 'item-1', final: 'false' }, closest: () => oldContainer };
  const context = {
    state: { assistantBubbles: new Map([['item-1', bubble]]) },
    els: { log: { querySelectorAll: () => [bubble] } },
    shouldPersistLocalAssistantBubble: () => false,
    appendMessage() {
      const container = { name: 'completed' }; containers.push(container);
      return { dataset: {}, closest: () => container };
    }
  };
  vm.createContext(context);
  vm.runInContext(fragment('function stableAssistantMessageId', 'function closeCommandMenu'), context);
  context.upsertAssistantMessage('✅ 完成', true, 'item-1', { type: 'message' });
  assert.deepEqual(containers.map(c => c.name), ['completed', 'new user']);
});

test('reentering a thread drops derived notice copies without collapsing genuine repeated replies', async () => {
  const { mergePersistentLiveVoiceMessages } = await import('../src/runner.js');
  const canonical = [
    { role: 'user', content: 'task one', at: '2026-10-04T15:06:00Z' },
    { role: 'assistant', content: '🤔 checking', at: '2026-10-04T15:07:00Z' },
    { role: 'user', content: 'task two', at: '2026-10-04T15:08:00Z' },
    { role: 'assistant', content: '🤔 checking', at: '2026-10-04T15:09:00Z' }
  ];
  const notices = [1, 2, 3].map(n => ({ role: 'assistant', content: '🤔 checking', threadNotice: true, at: `2026-10-04T15:10:0${n}Z` }));
  const error = { role: 'assistant', content: '错误：network failed', threadNotice: true, at: '2026-10-04T15:11:00Z' };
  let result = canonical;
  for (let i = 0; i < 3; i++) result = mergePersistentLiveVoiceMessages(result, [...notices, error]);
  assert.deepEqual(result, [...canonical, error]);
});

test('restoring live snapshot replies never writes assistant notices', () => {
  const calls = [];
  // Exercise the actual live-message loop from renderState.
  const start = source.indexOf('  for (const message of data.liveMessages || [])');
  const loop = source.slice(start, source.indexOf('  replayLocalNotices', start));
  const context = { data: { liveMessages: [{ role: 'assistant', content: '🤔 checking', final: true, messageId: 'item-1' }] }, renderedMessages: new Set(), renderedMessageKey: () => 'checking', upsertAssistantMessage: (...args) => calls.push(args) };
  vm.createContext(context); vm.runInContext(loop, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3].persist, false);
});
