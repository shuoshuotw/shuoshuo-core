const globals = globalThis as unknown as Record<symbol, unknown>;

// globalThis: Next can bundle a module once per route, so a module variable would split the state (M0 #12)
export function singleton<T>(name: string, create: () => T): T {
  const key = Symbol.for(`shuoshuo.${name}`);
  globals[key] ??= create();
  return globals[key] as T;
}
