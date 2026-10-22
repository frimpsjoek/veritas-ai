import type { Api } from "./api";
import { createRemoteRuntime } from "../../zotero-plugin/agent-src/src/remote.js";
import type { AgentService } from "../../zotero-plugin/agent-src/src/service";

/** The sidecar's routes are served by the same server as everything else in api.ts, under /agent. `Api.call`
 *  already carries the right base URL, desktop-vs-phone auth and error handling, so the transport just prefixes
 *  the path instead of re-implementing HTTP. */
function createObsidianTransport(api: Api) {
  return {
    request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
      return api.call(`/agent${path}`, method, body);
    },

    /** A protocol-agnostic event feed (service.d.ts): repeat GET /agent/events?after= until the caller stops
     *  asking (remote.js breaks out once it sees a `done`/`failed` event). requestUrl can't hold a socket open,
     *  so "long-poll" here is agentd's own bounded wait (up to 25s) plus an immediate re-ask, which reads the
     *  same to the UI as a single long-lived connection would. */
    async *stream(path: string, after: number, signal?: AbortSignal) {
      let cursor = after;
      let backoffMs = 0;
      while (!signal?.aborted) {
        let batch: { seq: number; type: string }[];
        try {
          batch = await api.call<{ seq: number; type: string }[]>(`/agent${path}${path.includes("?") ? "&" : "?"}after=${cursor}`);
          backoffMs = 0;
        } catch {
          backoffMs = Math.min(backoffMs ? backoffMs * 2 : 1000, 15000);
          await sleep(backoffMs); // the sidecar restarting or a blip on the phone's connection; keep trying
          continue;
        }
        for (const event of batch) {
          cursor = event.seq;
          yield { seq: event.seq, data: event };
        }
      }
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function createAgentService(api: Api): AgentService {
  return createRemoteRuntime(createObsidianTransport(api));
}
