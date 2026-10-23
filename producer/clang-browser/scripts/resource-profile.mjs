/** Keep release defaults stable; opt-in profiles need browser qualification. */
export function clangdResourceProfile(env = process.env) {
  const integer = (name, fallback, low, high) => {
    const text = env[name] ?? String(fallback);
    if (!/^\d+$/.test(text)) throw new Error(`${name} must be an integer`);
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < low || value > high)
      throw new Error(`${name} must be ${low}..${high}`);
    return value;
  };
  const initialMemoryMiB = integer(
    "CLANGD_INITIAL_MEMORY_MIB",
    2048,
    128,
    4096,
  );
  const pthreadPoolSize =
    env.CLANGD_PTHREAD_POOL_SIZE === undefined ||
    env.CLANGD_PTHREAD_POOL_SIZE === "auto"
      ? "auto"
      : integer("CLANGD_PTHREAD_POOL_SIZE", 8, 1, 64);
  return {
    initialMemoryMiB,
    pthreadPoolSize,
    poolExpression:
      pthreadPoolSize === "auto"
        ? "Math.max(navigator.hardwareConcurrency, 8)"
        : String(pthreadPoolSize),
  };
}
