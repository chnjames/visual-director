import '@testing-library/jest-dom/vitest';

/**
 * 测试环境 Storage polyfill。
 *
 * 背景：jsdom 25 + Node 18.17+/22 下，全局 localStorage 依赖 Node 的实验性
 * --localstorage-file 标志，未提供时 `globalThis.localStorage` 为 undefined，
 * 导致 security.test.ts / App.test.tsx 在 beforeEach 阶段崩溃（20 项红灯）。
 *
 * 策略：仅在宿主未提供时安装一个纯内存 Storage；jsdom 已提供 sessionStorage
 * 时保持原样，不替换真实实现。语义对齐浏览器 Storage：
 * - getItem 缺失键返回 null；
 * - key()/length 反映插入顺序；
 * - 键值作为可枚举自有属性（测试用 Object.values(storage) 巡检泄漏）。
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    for (const key of this.store.keys()) {
      delete (this as Record<string, unknown>)[key];
    }
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    if (this.store.delete(key)) {
      delete (this as Record<string, unknown>)[key];
    }
  }

  setItem(key: string, value: string): void {
    const v = String(value);
    this.store.set(key, v);
    Object.defineProperty(this, key, {
      value: v,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
}

if (typeof globalThis.sessionStorage === 'undefined') {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
}

/** React Flow (@xyflow/react) 依赖 ResizeObserver；jsdom 未提供 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: ResizeObserverStub,
    writable: true,
    configurable: true,
  });
}
