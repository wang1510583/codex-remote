import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteHosts } from '../src/remote-hosts.js';
import { handleRemoteHostHttp } from '../src/remote-host-routes.js';

function fixture(request) {
  const hosts = new RemoteHosts();
  hosts.control = async id => { assert.equal(id, 'remote'); return { request }; };
  return hosts;
}
test('remote file preview decodes Unicode text and returns image data without local paths', async () => {
  const hosts = fixture(async (method, params) => {
    if (method === 'fs/getMetadata') return { isFile: true };
    assert.equal(method, 'fs/readFile');
    return { dataBase64: Buffer.from(params.path.endsWith('.png') ? [137, 80, 78, 71] : '中文 <script>test</script>').toString('base64') };
  });
  const text = await hosts.file('remote', 'D:\\项目\\说明.txt');
  assert.equal(text.type, 'text');
  assert.equal(text.text, '中文 <script>test</script>');
  const image = await hosts.file('remote', '/project/image.png');
  assert.equal(image.url, 'data:image/png;base64,iVBORw==');
  await assert.rejects(hosts.file('remote', 'relative.txt'), /绝对路径/);
});

test('remote file preview rejects directories, binary contents and oversized text', async () => {
  const hosts = fixture(async (method, params) => {
    if (method === 'fs/getMetadata') return { isFile: params.path !== '/directory' };
    return { dataBase64: Buffer.from(params.path === '/large' ? 'x'.repeat(1024 * 1024 + 1) : [0, 255]).toString('base64') };
  });
  await assert.rejects(hosts.file('remote', '/directory'), /只能预览文件/);
  await assert.rejects(hosts.file('remote', '/binary'), /无法预览/);
  await assert.rejects(hosts.file('remote', '/large'), /超过 1MB/);
});
test('remote project files route lists files and directories on the selected computer', async () => {
  const hosts = fixture(async (method, params) => {
    assert.equal(method, 'fs/readDirectory');
    assert.equal(params.path, 'D:\\项目');
    return { entries: [
      { fileName: '说明.txt', isDirectory: false },
      { fileName: '子目录', isDirectory: true },
      { fileName: '../escape', isDirectory: false }
    ] };
  });
  hosts.host = async id => { assert.equal(id, 'remote'); return {}; };
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  const url = new URL('http://localhost/api/remote/files?connectorId=remote');
  url.searchParams.set('dir', 'D:\\项目');
  assert.equal(await handleRemoteHostHttp({ method: 'GET' }, response, url, hosts), true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.entries, [
    { name: '子目录', path: 'D:\\项目\\子目录', type: 'dir' },
    { name: '说明.txt', path: 'D:\\项目\\说明.txt', type: 'file' }
  ]);
  assert.equal(response.body.parent, 'D:\\');
  assert.deepEqual((await hosts.folders('remote', 'D:\\项目')).entries.map(item => item.type), ['dir']);
});
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
