import type { CreateEngine } from "../models/ClientAbc";
import WebSocketEngine from "./WebSocketEngine";

export default (
  function webSocketEngine(config) {
    return new WebSocketEngine({
      ...config,
      async createWebSocket(address, protocol) {
        if ("process" in globalThis) {
          const undiciVersion = process.versions["undici"];

          if (
            "WebSocket" in globalThis
            && typeof undiciVersion === "string"
            && undiciVersion
              .split(".")
              .map(p => parseInt(p, 10))
              .every((p, i, { length }) =>
                length === 3 && (
                  // undici v6.18.0 未満はフレーム解析に関するバグがあるため、利用しない。
                  (i === 0 && p >= 6)
                  || (i === 1 && p >= 18)
                  || (i === 2 && p >= 0)
                )
              )
          ) {
            return new WebSocket(address, protocol);
          }

          return await import("ws")
            .then(({ WebSocket }) => new WebSocket(address, protocol));
        }

        if ("WebSocket" in globalThis) {
          return new WebSocket(address, protocol);
        }

        return await import("ws")
          .then(({ WebSocket }) => new WebSocket(address, protocol));
      },
    });
  }
) satisfies CreateEngine;