import type { ValueOf } from "type-fest";
import { type Err, err, isBrowser, mutex, type Ok, ok } from "~/_internal";
import {
  ConnectionUnavailable,
  InvalidResponse,
  MissingNamespace,
  SurrealTypeError,
} from "~/errors";
import { copy, isArrayBuffer, Payload } from "~/formatters";
import type {
  IdLessRpcResponse,
  RpcParams,
  RpcRequest,
  RpcResult,
} from "~/index/types";
import EngineAbc, {
  CLOSED,
  CLOSING,
  CONNECTING,
  type EngineConfig,
  OPEN,
} from "./Abc";

/**
 * HTTP エンジンが fetch 関数に渡すリクエストの情報。
 */
export type HttpEngineFetchRequestInit = {
  method: "POST";
  headers: {
    "Content-Type": string;
    "Surreal-DB"?: string;
    "Surreal-NS"?: string;
    Accept: string;
    Authorization?: `Bearer ${string}`;
  };
  body: string | ArrayBuffer;
  signal: AbortSignal;
};

/**
 * fetch 関数が HTTP エンジンに返すべき HTTP レスポンス。
 */
export type HttpEngineFetchResponse = {
  /**
   * HTTP ステータスコード。200 以外は失敗したとみなされます。
   */
  readonly status: number;
  /**
   * レスポンスボディを ArrayBuffer として取得します。
   *
   * @returns レスポンスボディの ArrayBuffer。
   */
  readonly arrayBuffer: () => PromiseLike<ArrayBuffer>;
};

/**
 * HTTP エンジンが必要とする fetch 関数のインターフェース。
 */
export interface HttpEngineFetcher {
  /**
   * リクエストを送信し、HTTP レスポンスを取得します。
   *
   * @param endpoint リクエスト URL。
   * @param init リクエスト情報。
   * @returns HTTP レスポンス。
   */
  (
    endpoint: string,
    init: HttpEngineFetchRequestInit,
  ): Promise<HttpEngineFetchResponse>;
}

/**
 * HTTP エンジンの設定。
 */
export interface HttpEngineConfig extends EngineConfig {
  /**
   * HTTP エンジンが必要とする fetch 関数。
   *
   * @default fetch
   */
  readonly fetch?: HttpEngineFetcher | undefined;
}

/**
 * fetch 関数のレスポンスかどうかを判定します。
 *
 * @param value 判定する値。
 * @returns value が fetch 関数のレスポンスならば true。
 */
const isFetchResponse = (value: unknown): value is HttpEngineFetchResponse => (
  typeof value === "object"
  && value !== null
  && "status" in value
  && Number.isSafeInteger(value.status)
  && "arrayBuffer" in value
  && typeof value.arrayBuffer === "function"
);

/**
 * HTTP エンジン。
 */
export default class HttpEngine extends EngineAbc {
  /**
   * 現在の接続における変数。
   * HTTP ベースの RPC は "let" と "unset" メソッドへのリクエストで失敗しますが、
   * これは WebSocket ベースの RPC に相当する機能を提供するために使用されます。
   */
  protected vars: Record<string, unknown> = {};

  /**
   * fetch 関数の実装。
   */
  protected fetch: HttpEngineFetcher;

  /**
   * @param config HTTP エンジンの設定。
   */
  constructor(config: HttpEngineConfig) {
    super(config);
    this.fetch = config.fetch
      || (isBrowser ? window.fetch.bind(window) : fetch);
  }

  @mutex
  async connect(endpoint: URL): Promise<void> {
    if (this.state === OPEN) {
      return;
    }

    this.conn.endpoint = new URL(endpoint); // copy
    await this.setState(CONNECTING, () => {
      this.conn = {};

      return CLOSED;
    });

    await this.setState(OPEN, () => {
      this.conn = {};

      return CLOSED;
    });
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
      this.conn = {};
      this.vars = {};

      try {
        await this.setState(CLOSED, () => CLOSED);
      } catch {
        // 無視: `CLOSED` イベント内で発生したエラーは、
        // このエンジンを使用する `Surreal` が対処します。
      }
    }
  }

  async rpc(
    request: RpcRequest,
    signal: AbortSignal,
  ): Promise<IdLessRpcResponse> {
    if (this.state === CONNECTING) {
      await this.ee.once(OPEN);
    }

    if (!this.conn.endpoint) {
      throw new ConnectionUnavailable();
    }

    request = this.v8n.parseRpcRequest(request, {
      endpoint: new URL(this.conn.endpoint),
      engineName: "http",
    });

    switch (request.method) {
      case "use": {
        const [ns, db] = request.params;

        if (ns) {
          this.conn.ns = ns;
        }

        if (db) {
          if (!this.conn.ns) {
            throw new MissingNamespace();
          }

          this.conn.db = db;
        }

        return {
          result: null,
        };
      }

      case "let": {
        const [name, value] = request.params;
        this.vars[name] = await copy(this.fmt, value);

        return {
          result: null,
        };
      }

      case "unset": {
        const [name] = request.params;
        delete this.vars[name];

        return {
          result: null,
        };
      }

      case "query": {
        const [arg0, vars] = request.params;
        const { text, vars: varsBase } = typeof arg0 === "string"
          ? { text: arg0, vars: {} }
          : arg0;
        request = {
          method: request.method,
          params: [text, { ...this.vars, ...varsBase, ...vars }],
        };

        break;
      }
    }

    if (!this.conn.ns && this.conn.db) {
      throw new MissingNamespace();
    }

    if (!this.fmt.mimeType) {
      throw new SurrealTypeError("Formatter must have a MIME type");
    }

    const body: unknown = await this.fmt.encode(request);

    if (typeof body !== "string" && !isArrayBuffer(body)) {
      throw new SurrealTypeError(
        "The formatter encoded a non-string, non-ArrayBuffer value",
      );
    }

    const resp: unknown = await this.fetch(this.conn.endpoint.toString(), {
      body,
      signal,
      method: "POST",
      headers: {
        Accept: this.fmt.mimeType,
        "Content-Type": this.fmt.mimeType,
        ...(this.conn.ns ? { "Surreal-NS": this.conn.ns } : {}),
        ...(this.conn.db ? { "Surreal-DB": this.conn.db } : {}),
        ...(this.conn.token
          ? { Authorization: `Bearer ${this.conn.token}` }
          : {}),
      },
    });
    const cause = {
      request,
      endpoint: this.conn.endpoint.href,
      database: this.conn.db,
      namespace: this.conn.ns,
    };

    if (!isFetchResponse(resp)) {
      throw new InvalidResponse(
        "The response of the fetch function is an invalid interface.",
        {
          cause: {
            ...cause,
            response: resp,
          },
        },
      );
    }

    const buff: unknown = await resp.arrayBuffer();

    if (!isArrayBuffer(buff)) {
      throw new InvalidResponse(
        "The arrayBuffer method of the fetch function response "
          + "did not return an ArrayBuffer.",
        {
          cause: {
            ...cause,
            buffer: buff,
          },
        },
      );
    }

    const data = new Payload(buff);

    if (resp.status !== 200) {
      const message = await data.text();
      throw new InvalidResponse(message, {
        cause: {
          ...cause,
          status: resp.status,
          buffer: buff,
        },
      });
    }

    const decoded = await this.fmt.decode(data);
    const rpcResp = this.v8n.parseIdLessRpcResponse(decoded, {
      request,
      endpoint: new URL(this.conn.endpoint),
      engineName: "http",
    });

    if ("result" in rpcResp) {
      const rpc = {
        method: request.method,
        params: request.params,
        result: rpcResp.result = this.v8n.parseRpcResult(rpcResp.result, {
          request,
          endpoint: new URL(this.conn.endpoint),
          engineName: "http",
        }),
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

    // this.ee.emit(`rpc/${rpc.method}/${id}`, rpcResp);

    return rpcResp;
  }
}
