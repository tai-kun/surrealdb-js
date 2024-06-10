import type { Promisable } from "type-fest";
import { type AggregateTasksError, ResourceAlreadyDisposed } from "../errors";
import type { Err, Ok } from "./result";
import StatefulPromise from "./StatefulPromise";
import TaskQueue, { type TaskOptions, type TaskRunnerArgs } from "./TaskQueue";
import throwIfAborted from "./throwIfAborted";

interface TypedMap<T> {
  clear(): void;
  delete(key: keyof T): boolean;
  get<K extends keyof T>(key: K): T[K] | undefined;
  set<K extends keyof T>(key: K, value: T[K]): this;
  keys(): IterableIterator<keyof T>;
}

/**
 * タスクのイベントリスナー。
 *
 * @template A - イベントリスナーの引数の型。
 * @param runnerArgs - タスクランナーに渡される引数。
 * @param args - イベントリスナーの引数。
 */
export type TaskListener<A extends unknown[]> = (
  runnerArgs: TaskRunnerArgs,
  ...args: A
) => Promisable<void>;

/**
 * タスクのイベントリスナーのオプション。
 */
export interface TaskListenerOptions extends TaskOptions {}

/**
 * `TaskQueue` によって管理される非同期タスクのイベントエミッター。
 * 作成された `TaskEmitter` インスタンスは、最後に `.dispose()` を呼び出すことで破棄される必要があります。
 *
 * @template T - イベントの型。
 */
export default class TaskEmitter<T extends Record<string | number, unknown[]>> {
  #tasks = new TaskQueue();
  #listeners = new Map() as TypedMap<
    {
      [K in keyof T]: {
        task: TaskListener<T[K]>;
        emit: (args: T[K]) => StatefulPromise<unknown>;
      }[];
    }
  >;

  /**
   * イベントリスナーを追加します。
   *
   * @template K - イベントの型。
   * @param event - リスナーを追加するイベント。
   * @param listener - 追加するリスナー。
   */
  on<K extends keyof T>(
    event: K,
    listener: TaskListener<T[K]>,
  ): void {
    if (this.disposed) {
      throw new ResourceAlreadyDisposed("TaskEmitter");
    }

    let listeners = this.#listeners.get(event);

    if (!listeners?.find(({ task }) => task === listener)) {
      if (!listeners) {
        this.#listeners.set(event, listeners = []);
      }

      listeners.push({
        task: listener,
        emit: args =>
          this.#tasks.add(runnerArgs => listener(runnerArgs, ...args)),
      });
    }
  }

  /**
   * イベントリスナーを削除します。
   *
   * @template K - イベントの型。
   * @param event - リスナーを削除するイベント。
   * @param listener - 削除するリスナー。
   */
  off<K extends keyof T>(event: K, listener?: TaskListener<T[K]>): void {
    const listeners = this.#listeners.get(event);

    if (listeners) {
      if (listener) {
        const index = listeners.findIndex(({ task }) => task === listener);

        if (index !== -1) {
          listeners.splice(index, 1);

          if (listeners.length === 0) {
            this.#listeners.delete(event);
          }
        }
      } else {
        this.#listeners.delete(event);
      }
    }
  }

  /**
   * イベントを待機します。
   *
   * @template K - イベントの型。
   * @param event - 待機するイベント。
   * @param options - タスクリスナーのオプション。
   * @returns イベントリスナーに渡された引数。
   * @example
   * ```ts
   * const args = await taskEmitter.once("event");
   * ```
   * @example
   * ```ts
   * const signal = AbortSignal.timeout(5_000);
   * const args = await taskEmitter.once("event", { signal });
   * ```
   */
  once<K extends keyof T>(
    event: K,
    options: TaskListenerOptions | undefined = {},
  ): StatefulPromise<T[K]> {
    const { promise, resolve, reject } = StatefulPromise.withResolvers<T[K]>();

    try {
      if (this.disposed) {
        throw new ResourceAlreadyDisposed("TaskEmitter");
      }

      let listeners = this.#listeners.get(event);

      if (!listeners) {
        this.#listeners.set(event, listeners = []);
      }

      const { signal } = options;
      const taskId = () => {};
      const handleAbort = (): void => {
        this.off(event, taskId);
        reject(signal!.reason);
      };
      throwIfAborted(signal);
      signal?.addEventListener("abort", handleAbort, { once: true });
      listeners.push({
        task: taskId,
        emit: args => {
          this.off(event, taskId);
          signal?.removeEventListener("abort", handleAbort);
          resolve(args);

          return promise;
        },
      });
    } catch (error) {
      reject(error);
    }

    return promise;
  }

  /**
   * イベントを発生させます。
   * この emit によってトリガされたイベントリスナーを待つために `Promise.all` を使用できます。
   * `.dispose()` で正しく破棄されるなら、これらの Promise を待つ必要はなく、リソースリークも発生しません。
   *
   * @template K - イベントの型。
   * @param event - 発生させるイベント。
   * @param args - イベントリスナーに渡される引数。
   * @returns このイベントによってトリガーされたイベントリスナーの Promise のリスト。
   * @example
   * ```ts
   * taskEmitter.emit("event", 1);
   * ```
   * @example
   * ```ts
   * const promises = taskEmitter.emit("event", 1);
   * const results = await Promise.all(promises || []);
   * ```
   */
  emit<K extends keyof T>(
    event: K,
    ...args: T[K]
  ): undefined | StatefulPromise<unknown>[] {
    return this.#listeners.get(event)?.map(({ emit }) => emit(args));
  }

  /**
   * このインスタンスが破棄されているかどうか。
   */
  get disposed(): boolean {
    return this.#tasks.disposed;
  }

  /**
   * このインスタンスを破棄し、すべてのタスクが終了するまで待機します。
   *
   * @returns タスクがすべて成功した場合は `Ok`、そうでない場合は `Err` を返します。
   */
  async dispose(): Promise<Ok | Err<AggregateTasksError>> {
    return await this.#tasks.dispose();
  }

  /**
   * すべてのタスクを中止します。
   *
   * @param reason - 中止の理由。
   */
  abort(reason?: unknown): void {
    this.#tasks.abort(reason);
  }
}