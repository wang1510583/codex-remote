import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/remote.js', import.meta.url), 'utf8');
const openFilesSource = source.slice(source.indexOf('async function openFiles('), source.indexOf('function fileActionButton('));

function harness(request) {
  const children = [];
  const context = {
    state: { connectorId: '' },
    els: {
      modelSettingsPanel: {}, threadPanel: {}, threadButton: { setAttribute() {} },
      filePreview: {}, fileList: { innerHTML: '', appendChild: row => children.push(row) }, filePath: {}
    },
    request, setThreadView() {},
    displayProjectPath: (_cwd, absoluteCwd) => absoluteCwd,
    applyDotFolderFilter() {},
    document: { createElement: () => ({ dataset: {} }) }
  };
  vm.createContext(context);
  vm.runInContext(openFilesSource, context);
  return { context, children };
}

test('local project browser opens root and nested folders without a connector identifier error', async () => {
  for (const cwd of ['', '项目/子目录']) {
    const { context, children } = harness(async url => {
      assert.equal(url, `/api/remote/files?dir=${encodeURIComponent(cwd)}`);
      return { cwd, absoluteCwd: `/workspace/${cwd}`, parent: '项目', entries: [] };
    });
    await context.openFiles(cwd);
    assert.equal(context.els.fileList.innerHTML, '');
    assert.equal(context.state.fileCwd, cwd);
    assert.equal(context.els.filePath.textContent, `/workspace/${cwd}`);
    assert.equal(children.length, cwd ? 1 : 0);
    if (cwd) assert.equal(children[0].dataset.path, '项目');
  }
});

test('local project browser ignores a response after switching computers', async () => {
  let resolve;
  const { context, children } = harness(() => new Promise(r => { resolve = r; }));
  const opening = context.openFiles('项目');
  context.state.connectorId = 'remote-host';
  resolve({ cwd: '项目', entries: [] });
  await opening;
  assert.equal(context.state.fileCwd, undefined);
  assert.equal(children.length, 0);
});
