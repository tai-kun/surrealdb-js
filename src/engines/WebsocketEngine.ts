import type { Promisable, ValueOf } from "type-fest";
import type { WebSocket } from "ws";
import {
  ConnectionUnavailable,
  MissingNamespace,
  ResponseError,
} from "../common/errors";
import { RpcResponseData } from "../common/RpcResponseData";
import type {
  BidirectionalRpcResponse,
  RpcParams,
  RpcRequest,
  RpcResult,
} from "../common/types";
import { makeAbortApi } from "../internal";
import { type Err, err, mutex, type Ok, ok, SerialId } from "../internal";
import {
  CLOSED,
  CLOSING,
  CONNECTING,
  Engine,
  type EngineConfig,
  OPEN,
} from "./Engine";

/**
 * Creates a WebSocket connection.
 *
 * @param address - The URL for the WebSocket connection.
 * @param protocol - The protocol for the WebSocket connection.
 * @returns The WebSocket connection.
 */
export type CreateWebSocket = (
  address: URL,
  protocol: string | undefined,
) => Promisable<WebSocket>;

/**
 * The WebSocket engine configuration.
 */
export interface WebsocketEngineConfig extends EngineConfig {
  /**
   * The WebSocket connection creator.
   */
  readonly createWebSocket: CreateWebSocket;
}

/**
 * The WebSocket engine for `Surreal`.
 */
export class WebsocketEngine extends Engine {
  protected id = new SerialId();
  protected ws: WebSocket | null = null;
  protected createWs: CreateWebSocket;

  /**
   * Creates a new WebSocket engine.
   *
   * @param config - The configuration for the WebSocket engine.
   */
  constructor(config: WebsocketEngineConfig) {
    super(config);
    this.createWs = config.createWebSocket;
  }

  @mutex
  async connect(url: URL): Promise<void> {
    if (this.state === OPEN) {
      return;
    }

    this.conn.url = new URL(url); // copy
    await this.setState(CONNECTING, () => {
      this.conn = {};

      return CLOSED;
    });

    const [signal, abort] = makeAbortApi();
    const timeout = setTimeout(() => abort("Timeout"), 15_000);
    signal.addEventListener("abort", () => clearTimeout(timeout));
    const promise = Promise.race([
      this.ee.once(OPEN, { signal }),
      this.ee.once(CLOSED, { signal }),
      this.ee.once("error", { signal }),
    ]);
    const ws = await this.createWs(new URL(url), this.fmt.protocol);
    ws.addEventListener("error", evt => {
      this.ee.emit("error", {
        name: "WebsocketEngineError",
        code: 3000,
        /**
         * We are not certain if the event has a `message` property.
         *
         * - Mozilla: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/error_event#event_type
         * - Node.js:
         *     - undici: https://github.com/nodejs/undici/blob/v6.18.1/types/websocket.d.ts#L127-L133
         *     - ws: https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/ws/index.d.ts#L289-L294
         * - Deno: https://github.com/denoland/deno/blob/v1.43.6/ext/web/02_event.js#L1064-L1133
         */
        message: "message" in evt && evt.message != null
          ? String(evt.message)
          : "The \"error\" event was caught.",
        ...("error" in evt ? { cause: evt.error } : {}),
        critical: true,
      });
    });
    ws.addEventListener("close", async evt => {
      this.id = new SerialId();
      this.ws = null;
      this.conn = {};

      switch (evt.code) {
        case 1000: // Normal Closure
        case 1004: // Reserved (Not Used)
        case 1005: // No Status Received
        // We do not treat connection codes resulting from early termination as errors.
        case 1001: // Going Away
        case 1006: // Abnormal Closure
          break;

        case 1002: // Protocol Error
        case 1003: // Unsupported Data
        case 1007: // Invalid Frame Payload Data
        case 1008: // Policy Violation
        case 1009: // Message Too Big
        case 1010: // Mandatory Extension
        case 1011: // Internal Server Error
        case 1012: // Service Restart
        case 1013: // Try Again Later
        case 1014: // Bad Gateway
        case 1015: // TLS Handshake
          this.ee.emit("error", {
            name: "WebsocketEngineError",
            code: evt.code,
            message: evt.reason,
          });
      }

      try {
        await this.setState(CLOSED, () => CLOSED);
      } catch {
        // Ignore
        // Errors that occur within the `CLOSED` event are handled
        // by `SurrealCore`, which uses this engine.
      }
    });
    ws.addEventListener("open", async () => {
      try {
        this.ws = ws;
        await this.setState(OPEN, () => {
          this.ws = null;
          this.conn = {};

          return CLOSED;
        });
      } catch (error) {
        this.ee.emit("error", {
          name: "WebsocketEngineError",
          code: 3001,
          message:
            "An error occurred within the handler for the \"open\" event.",
          cause: error,
          critical: true,
        });
      }
    });
    ws.addEventListener("message", async evt => {
      try {
        const data = new RpcResponseData(evt.data as any);
        const decoded = await this.fmt.decode(data);
        const rpcResp = this.v8n.parseRpcResponse(decoded).unwrap();

        if ("id" in rpcResp) {
          this.ee.emit(`rpc/${rpcResp.id}`, rpcResp);
        } else if ("result" in rpcResp) {
          const { id, ...liveResult } = this.v8n
            .parseLiveResult(rpcResp.result)
            .unwrap();
          this.ee.emit(`live/${id}`, liveResult);
        } else {
          throw new ResponseError(rpcResp.error);
        }
      } catch (error) {
        this.ee.emit("error", {
          name: "WebsocketEngineError",
          code: 3002,
          message:
            "An error occurred within the handler for the \"message\" event.",
          cause: error,
          critical: false,
        });
      }
    });

    try {
      await promise;
    } finally {
      if (!signal.aborted) {
        abort();
      }
    }
  }

  @mutex
  async disconnect(): Promise<
    | Ok<"Disconnected">
    | Ok<"AlreadyDisconnected">
    | Err<unknown>
  > {
    if (this.state === CLOSED) {
      return ok("AlreadyDisconnected");
    }

    try {
      await this.setState(CLOSING, () => CLOSING);

      return ok("Disconnected");
    } catch (error) {
      return err(error);
    } finally {
      if (
        this.ws
        && this.ws.readyState !== CLOSED
        && this.ws.readyState !== CLOSING
      ) {
        this.ws.close();
      }
    }
  }

  async rpc(
    request: RpcRequest,
    signal: AbortSignal,
  ): Promise<BidirectionalRpcResponse> {
    if (this.state === CONNECTING) {
      await this.ee.once(OPEN);
    }

    if (!this.ws) {
      throw new ConnectionUnavailable();
    }

    request = this.v8n.parseRpcRequest(request).unwrap();

    switch (request.method) {
      case "use": {
        const [ns, db] = request.params;

        if (!this.conn.ns && !ns && db) {
          throw new MissingNamespace();
        }

        break;
      }

      case "query": {
        const [arg0, vars] = request.params;
        const { text, vars: varsBase } = typeof arg0 === "string"
          ? { text: arg0, vars: {} }
          : arg0;
        request = {
          method: request.method,
          params: [text, { ...varsBase, ...vars }],
        };

        break;
      }
    }

    const id: BidirectionalRpcResponse["id"] =
      `${request.method}/${this.id.next()}`;
    const rawRpcData: unknown = await this.fmt.encode({ ...request, id });
    const rpcData = this.v8n.parseRpcData(rawRpcData).unwrap();
    const promise = this.ee.once(`rpc/${id}`, { signal });
    this.ws.send(rpcData);
    const [rawResp] = await promise;
    const rpcResp = rawResp as BidirectionalRpcResponse; // `rawResp` is validated in the "message" event listener

    if ("result" in rpcResp) {
      const rpc = {
        method: request.method,
        params: request.params,
        result: this.v8n.parseRpcResult(rpcResp.result, request).unwrap(),
      } as ValueOf<
        {
          [M in (typeof request)["method"]]: {
            method: M;
            params: RpcParams<M>;
            result: RpcResult<M>;
          };
        }
      >;

      switch (rpc.method) {
        case "use": {
          const [ns, db] = rpc.params;

          if (ns) {
            this.conn.ns = ns;
          }

          if (db) {
            this.conn.db = db;
          }

          break;
        }

        case "signin":
        case "signup":
          this.conn.token = rpc.result;

          break;

        case "authenticate": {
          const [token] = rpc.params;
          this.conn.token = token;

          break;
        }

        case "invalidate":
          delete this.conn.token;

          break;
      }
    }

    return rpcResp;
  }
}
