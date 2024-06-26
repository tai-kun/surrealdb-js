import {
  type Err,
  err,
  getTimeoutSignal,
  makeAbortApi,
  mutex,
  type Ok,
  ok,
  TaskEmitter,
} from "~/_internal";
import { CLOSED, CONNECTING, OPEN } from "~/engines";
import {
  type AggregateTasksError,
  ConnectionConflict,
  ConnectionUnavailable,
  EngineDisconnected,
  RpcResponseError,
  unreachable,
} from "~/errors";
import type {
  RpcMethod,
  RpcParams,
  RpcResponse,
  RpcResult,
} from "~/index/types";
import Abc, {
  type ClientConnectOptions,
  type ClientDisconnectOptions,
  ClientRpcOptions,
} from "../../_client/Abc";

export default class Client extends Abc {
  @mutex
  async connect(
    endpoint: string | URL,
    options: ClientConnectOptions | undefined = {},
  ): Promise<void> {
    endpoint = new URL(endpoint); // copy

    if (!endpoint.pathname.endsWith("/rpc")) {
      if (!endpoint.pathname.endsWith("/")) {
        endpoint.pathname += "/";
      }

      endpoint.pathname += "rpc";
    }

    if (this.state === OPEN) {
      if (!this.conn?.connection.endpoint) {
        unreachable();
      }

      if (this.conn.connection.endpoint.href === endpoint.href) {
        return;
      }

      throw new ConnectionConflict(this.conn?.connection.endpoint, endpoint);
    }

    this.ee.on("error", (_, error) => {
      if (error.fatal) {
        console.error(error);
        this.disconnect({ force: true }).then(result => {
          if (!result.ok) {
            console.error(result.error);
          }
        });
      } else {
        console.warn(error);
      }
    });
    const protocol = endpoint.protocol.slice(0, -1 /* remove `:` */);
    const engine = this.conn = await this.createEngine(protocol);
    const { signal = getTimeoutSignal(15_000) } = options;
    await engine.connect(endpoint, signal);
  }

  @mutex
  async disconnect(
    options: ClientDisconnectOptions | undefined = {},
  ): Promise<
    | Ok
    | Ok<"AlreadyDisconnected">
    | Err<{
      disconnect?: unknown;
      dispose?: AggregateTasksError;
    }>
  > {
    try {
      if (!this.conn || this.state === CLOSED) {
        return ok("AlreadyDisconnected");
      }

      const {
        force = false,
        signal = getTimeoutSignal(15_000),
      } = options;

      if (force) {
        this.ee.abort(new EngineDisconnected());
      }

      const disconnResult = await this.conn.disconnect(signal);
      const disposeResult = await this.ee.dispose();

      if (!disconnResult.ok || !disposeResult.ok) {
        const error: {
          disconnect?: unknown;
          dispose?: AggregateTasksError;
        } = {};

        if (!disconnResult.ok) {
          error.disconnect = disconnResult.error;
        }

        if (!disposeResult.ok) {
          error.dispose = disposeResult.error;
        }

        return err(error);
      }

      return disposeResult;
    } finally {
      this.ee = new TaskEmitter();
      this.conn = null;
    }
  }

  async rpc<M extends RpcMethod, T extends RpcResult<M>>(
    method: M,
    params: RpcParams<M>,
    options: ClientRpcOptions | undefined = {},
  ): Promise<T> {
    const { signal: timeoutSignal = getTimeoutSignal(5_000) } = options;

    if (this.state === CONNECTING) {
      const [signal, abort] = makeAbortApi(timeoutSignal);
      const [result] = await Promise.race([
        this.ee.once(OPEN, { signal }),
        this.ee.once(CLOSED, { signal }),
      ]);

      abort();

      if (result.value === OPEN && result.ok) {
        // 次に進める
      } else {
        throw new ConnectionUnavailable({
          cause: result.ok
            ? "Connection Closed."
            : result.error,
        });
      }
    }

    if (!this.conn) {
      throw new ConnectionUnavailable();
    }

    const resp: RpcResponse<any> = await this.conn.rpc(
      // @ts-expect-error
      { method, params },
      timeoutSignal,
    );

    if ("result" in resp) {
      return resp.result;
    }

    throw new RpcResponseError(resp);
  }
}
