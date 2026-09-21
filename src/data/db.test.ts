import { describe, it, expect } from 'vitest';
import { PersistedKey } from './db';
import type { KeyIO, SaveStatus } from './db';

/**
 * 构造可控制完成顺序的 IO：每次 write 的 promise 在 resolveNext 时才完成，
 * 用来证明“即便底层写入被排队控制，逻辑落盘顺序仍严格等于入队顺序，
 * 旧快照不可能后发先至覆盖新快照”。
 */
/** 推进所有待执行的微任务/Promise 链（setTimeout 为宏任务，足够 flush then 链） */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function controllableIo(initial?: unknown) {
  const actions: Array<() => void> = [];
  let stored: unknown = initial;
  const order: number[] = [];

  const io: KeyIO = {
    read: async () => stored,
    write: (wrapped) =>
      new Promise<SaveStatus>((resolve) => {
        actions.push(() => {
          stored = wrapped;
          order.push(wrapped.seq);
          resolve('idb');
        });
      }),
    remove: async () => {
      stored = undefined;
    },
    memoryRead: () => undefined,
    memoryWrite: () => undefined,
    memoryRemove: () => undefined,
  };

  return {
    io,
    resolveNext: () => actions.shift()?.(),
    pendingWrites: () => actions.length,
    storedData: () => (stored as { data?: unknown } | undefined)?.data,
    storedSeq: () => (stored as { seq?: number } | undefined)?.seq,
    completedOrder: () => [...order],
  };
}

describe('PersistedKey 串行写队列', () => {
  it('连续保存严格串行；顺序完成后最终值是最新状态且序号单调', async () => {
    const c = controllableIo();
    const key = new PersistedKey<string>(c.io);
    expect(await key.load((d) => d as string)).toBeNull();

    // 连续三次保存且不等待（模拟引擎 onChange 连发导致的旧 useEffect 写）
    const p1 = key.enqueue('v1');
    const p2 = key.enqueue('v2');
    const p3 = key.enqueue('v3');

    // 链上首个写入启动
    await flush();
    // 同一时刻只有一个在途写，后两次排队
    expect(c.pendingWrites()).toBe(1);

    c.resolveNext(); // v1 完成 → v2 自动出队开始
    await flush();
    c.resolveNext(); // v2 完成 → v3 自动出队开始
    await flush();
    c.resolveNext(); // v3 完成
    await flush();
    const statuses = await Promise.all([p1, p2, p3]);

    expect(statuses).toEqual(['idb', 'idb', 'idb']);
    expect(c.storedData()).toBe('v3');
    expect(c.storedSeq()).toBe(3);
    expect(c.completedOrder()).toEqual([1, 2, 3]);
  });

  it('load 继承存储中的 seq，后续写入序号继续递增不回退', async () => {
    const c = controllableIo({ __persistVersion: 1, seq: 10, data: 'resumed' });
    const key = new PersistedKey<string>(c.io);
    expect(await key.load((d) => d as string)).toBe('resumed');

    const p = key.enqueue('next');
    await flush(); // 等待链上写入启动
    c.resolveNext();
    await flush();
    expect(await p).toBe('idb');
    expect(c.storedSeq()).toBe(11);
    expect(c.storedData()).toBe('next');
  });

  it('兼容旧版裸文档：读取透传，下一次保存自动升级为包装格式', async () => {
    let stored: unknown = 'legacy-doc'; // 旧版本：裸业务文档
    const io: KeyIO = {
      read: async () => stored,
      write: async (wrapped) => {
        stored = wrapped;
        return 'idb';
      },
      remove: async () => {
        stored = undefined;
      },
      memoryRead: () => undefined,
      memoryWrite: () => undefined,
      memoryRemove: () => undefined,
    };
    const key = new PersistedKey<string>(io);
    expect(await key.load((d) => d as string)).toBe('legacy-doc');
    expect(await key.enqueue('upgraded')).toBe('idb');
    expect((stored as { __persistVersion?: number }).__persistVersion).toBe(1);
    expect((stored as { data?: unknown }).data).toBe('upgraded');
  });

  it('损坏数据不半信任加载（返回 null），之后的新保存正常生效', async () => {
    let stored: unknown = { __persistVersion: 1, seq: 2, data: 'bad' };
    const io: KeyIO = {
      read: async () => stored,
      write: async (wrapped) => {
        stored = wrapped;
        return 'idb';
      },
      remove: async () => {
        stored = undefined;
      },
      memoryRead: () => undefined,
      memoryWrite: () => undefined,
      memoryRemove: () => undefined,
    };
    const key = new PersistedKey<string>(io);
    const loaded = await key.load((d) => {
      if (d !== 'good') throw new Error('shape mismatch');
      return d as string;
    });
    expect(loaded).toBeNull();

    expect(await key.enqueue('good')).toBe('idb');
    const reopen = new PersistedKey<string>(io);
    expect(await reopen.load((d) => d as string)).toBe('good');
  });

  it('落盘抛错时回报 failed 并转存内存兜底，不阻断后续写入', async () => {
    let calls = 0;
    const mem: Record<string, unknown> = {};
    const io: KeyIO = {
      read: async () => undefined,
      write: async (wrapped) => {
        calls += 1;
        if (calls === 1) throw new Error('IDB write failed');
        mem.stored = wrapped;
        return 'idb';
      },
      remove: async () => undefined,
      memoryRead: () => mem.fallback,
      memoryWrite: (wrapped) => {
        mem.fallback = wrapped;
      },
      memoryRemove: () => undefined,
    };
    const key = new PersistedKey<string>(io);
    await key.load((d) => d as string);

    expect(await key.enqueue('first')).toBe('failed');
    expect((mem.fallback as { data?: unknown })?.data).toBe('first');
    // IDB 为空时，load 必须仍能从 memory 读回，不能被空主存冲掉
    expect(await key.load((d) => d as string)).toBe('first');
    // 链不因失败中断：下一次写入照常串行执行
    expect(await key.enqueue('second')).toBe('idb');
    expect((mem.stored as { data?: unknown }).data).toBe('second');
  });

  it('IDB 读到旧值时优先采用序号更高的 memory 兜底', async () => {
    const idb = { __persistVersion: 1 as const, seq: 1, data: 'old' };
    const mem = { __persistVersion: 1 as const, seq: 3, data: 'fresh' };
    const io: KeyIO = {
      read: async () => idb,
      write: async () => 'idb',
      remove: async () => undefined,
      memoryRead: () => mem,
      memoryWrite: () => undefined,
      memoryRemove: () => undefined,
    };
    const key = new PersistedKey<string>(io);
    expect(await key.load((d) => d as string)).toBe('fresh');
  });

  it('无 IndexedDB 环境写内存：状态为 memory，重载可读回', async () => {
    const mem: Record<string, unknown> = {};
    const io: KeyIO = {
      read: async () => mem.v ?? null,
      write: async () => 'memory',
      remove: async () => {
        delete mem.v;
      },
      memoryRead: () => mem.v,
      memoryWrite: (wrapped) => {
        mem.v = wrapped;
      },
      memoryRemove: () => {
        delete mem.v;
      },
    };
    const key = new PersistedKey<string>(io);
    await key.load((d) => d as string);
    expect(await key.enqueue('in-memory')).toBe('memory');
    expect((mem.v as { data?: unknown }).data).toBe('in-memory');

    const reopen = new PersistedKey<string>(io);
    expect(await reopen.load((d) => d as string)).toBe('in-memory');
  });

  it('enqueueMutate 串行读改写，并发不会互相覆盖', async () => {
    const c = controllableIo({ __persistVersion: 1, seq: 0, data: { n: 0 } });
    const key = new PersistedKey<{ n: number }>(c.io);
    await key.load((d) => d as { n: number });

    const p1 = key.enqueueMutate((prev) => ({ n: (prev?.n ?? 0) + 1 }));
    const p2 = key.enqueueMutate((prev) => ({ n: (prev?.n ?? 0) + 1 }));
    const p3 = key.enqueueMutate((prev) => ({ n: (prev?.n ?? 0) + 1 }));

    await flush();
    expect(c.pendingWrites()).toBe(1);
    c.resolveNext();
    await flush();
    c.resolveNext();
    await flush();
    c.resolveNext();
    await flush();

    const results = await Promise.all([p1, p2, p3]);
    expect(results.map((r) => r.value?.n)).toEqual([1, 2, 3]);
    expect(c.storedData()).toEqual({ n: 3 });
  });
});
