import { remoteHosts } from "./remote-hosts.js";
import { json, readBody } from "./utils.js";

// Called only after the main router's login check. A scoped request either
// completes here or fails here; it can never execute against the local host.
export async function handleRemoteHostHttp(req, res, url, hosts = remoteHosts) {
  if (url.pathname === "/api/remote/hosts") {
    if (req.method === "GET") json(res, 200, { hosts: await hosts.list() });
    else if (req.method === "POST") json(res, 200, { host: await hosts.add(await readBody(req, 16384)) });
    else if (req.method === "DELETE") {
      await hosts.remove((await readBody(req)).id);
      json(res, 200, { ok: true });
    } else json(res, 405, { error: "不支持的请求方式。" });
    return true;
  }
  const id = url.searchParams.get("connectorId");
  if (!id || !url.pathname.startsWith("/api/remote/")) return false;
  await hosts.host(id);
  const route = url.pathname.slice("/api/remote/".length);
  const full = url.searchParams.get("full") === "1";
  let result;
  if (req.method === "GET") {
    if (route === "threads") result = await hosts.threads(id);
    else if (route === "state") result = await hosts.state(id, { full });
    else if (route === "model-settings") {
      const state = await hosts.state(id);
      const server = await hosts.control(id);
      const settings = state.threadId
        ? await server.readThreadSettings(state.threadId, state.cwd)
        : await server.configuredModelSettings("");
      result = { ...state, ...settings, models: await server.modelOptions() };
    } else if (route === "usage") {
      const usage = await (await hosts.control(id)).readRateLimits();
      result = { ...usage.rateLimits, resetCredits: usage.rateLimitResetCredits || { availableCount: 0, credits: [] } };
    }
  } else if (req.method === "POST") {
    const body = await readBody(req);
    if (route === "select") result = await hosts.select(id, body.threadId);
    else if (route === "draft") result = await hosts.draft(id, body);
    else if (route === "send") result = await hosts.send(id, body);
    else if (route === "more") result = await hosts.state(id, { full, limit: 10000 });
    else if (route === "approval/respond") result = { ok: true, ...await hosts.respond(id, body) };
    else if (["new", "name", "delete"].includes(route)) {
      const server = await hosts.control(id);
      if (route === "new") {
        const cwd = String(body.cwd || "").trim();
        if (!cwd || cwd.length > 4096) throw Object.assign(new Error("请输入远端项目的绝对路径。"), { statusCode: 400 });
        const created = await server.request("thread/start", { cwd });
        result = await hosts.select(id, created.thread.id);
      } else {
        const view = await hosts.read(id, body.threadId);
        if (route === "delete") {
          if (view.running || hosts.runs.get(`${id}:${body.threadId}`)?.running) throw Object.assign(new Error("运行中的会话不能删除。"), { statusCode: 409 });
          await server.request("thread/delete", { threadId: body.threadId });
          if ((await hosts.saved(id)).threadId === body.threadId) await hosts.save(id, { threadId: "" });
          result = { ok: true };
        } else {
          const name = String(body.name || "").trim().slice(0, 200);
          await server.request("thread/name/set", { threadId: body.threadId, name });
          result = { ok: true, name, title: name || "未命名会话" };
        }
      }
    }
  }
  if (result === undefined) json(res, 400, { error: "当前操作尚不支持远端电脑，请切回本机操作。" });
  else json(res, 200, result);
  return true;
}
