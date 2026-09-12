/**
 * 进程内环形日志 —— 书源排错时最需要的东西。
 * 不落盘，重启即清空；容量可配（SHUHAI_LOG_SIZE，默认 500）。
 */

const SIZE = Math.max(50, Number(process.env.SHUHAI_LOG_SIZE || 500));
const buffer = [];
let seq = 0;

export function push(level, msg, ctx) {
  const entry = { id: ++seq, ts: Date.now(), level, msg: String(msg) };
  if (ctx !== undefined && ctx !== null) {
    try { entry.ctx = typeof ctx === 'string' ? ctx : JSON.stringify(ctx).slice(0, 500); }
    catch { entry.ctx = String(ctx); }
  }
  buffer.push(entry);
  if (buffer.length > SIZE) buffer.splice(0, buffer.length - SIZE);
  if (level === 'error') {
    // 错误同时打到标准输出，方便 docker logs 查看
    console.error('[shuhai]', msg);
  }
  return entry;
}

export const debug = (m, c) => push('debug', m, c);
export const info = (m, c) => push('info', m, c);
export const warn = (m, c) => push('warn', m, c);
export const error = (m, c) => push('error', m, c);

export function tail(limit = 200) {
  const n = Math.max(1, Math.min(Number(limit) || 200, SIZE));
  return buffer.slice(-n);
}

export function clear() { buffer.length = 0; }

/** 创建一个绑定了上下文的 logger，方便在请求里携带书源信息 */
export function scoped(baseCtx) {
  return (level, msg) => push(level, msg, baseCtx);
}
