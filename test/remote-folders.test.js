import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteHosts } from '../src/remote-hosts.js';

function fixture(request) {
  const hosts = new RemoteHosts();
  hosts.control = async id => { assert.equal(id, 'remote'); return { request }; };
  return hosts;
}
test('remote Windows picker lists drives and preserves literal Unicode folder paths', async () => {
  const calls = [];
  const hosts = fixture(async (method, params) => {
    calls.push({method, params});
    if (method === 'command/exec') return { exitCode: 0, stdout: JSON.stringify(['C:\\', 'D:\\']) };
    return {entries: [{fileName: "项目 ' $文件", isDirectory: true}, {fileName: 'file.txt', isDirectory: false}]};
  });
  const roots = await hosts.folders('remote');
  assert.equal(roots.selectable, false);
  assert.deepEqual(roots.entries.map(x => x.path), ['C:\\', 'D:\\']);
  const disk = await hosts.folders('remote', 'D:\\');
  assert.equal(disk.parent, '');
  assert.equal(disk.entries[0].path, "D:\\项目 ' $文件");
  const nested = await hosts.folders('remote', disk.entries[0].path);
  assert.equal(nested.parent, 'D:\\');
  assert.equal(calls.at(-1).method, 'fs/readDirectory');
  assert.equal(calls.at(-1).params.path, disk.entries[0].path);
});
test('remote POSIX picker falls back to root and propagates read failures', async () => {
  const hosts = fixture(async (method, params) => {
    if (method === 'command/exec') throw new Error('program not found');
    if (params.path === '/private') throw new Error('Permission denied');
    return {entries: [{fileName: 'home', isDirectory: true}, {fileName: '../escape', isDirectory: true}]};
  });
  const root = await hosts.folders('remote');
  assert.equal(root.cwd, '/');
  assert.equal(root.parent, null);
  assert.equal(root.selectable, true);
  assert.deepEqual(root.entries, [{name:'home', path:'/home', type:'dir'}]);
  await assert.rejects(hosts.folders('remote', '/private'), /Permission denied/);
  await assert.rejects(hosts.folders('remote', 'relative'), /绝对路径/);
});
