// UI 偏好服务端持久化
//
// 为什么需要这个模块：以前「每次进入应用弹风险提示」这类开关只存 localStorage。
// fnOS 上这个应用会同时出现在两种上下文里：
//   · 应用中心点进去 = iframe（frame 模式）
//   · 新窗口打开     = CEF 独立窗口
// 两者的 localStorage 可能落在不同的存储分区，部分环境还会直接禁用或被清空。
// 于是同一个开关的表现变成「这次生效、下次又弹出来」—— 用户报的
// 「勾选后有时还是会弹出」就是这个原因，代码逻辑本身没有分支错误。
//
// 现在改成：**服务端文件是唯一真理源**，localStorage 只当本地缓存 + 离线兜底。
//
// 文件落在 <TRM_PKGVAR>/data/ui-prefs.json（跟 scan_exclude.json 同一层），
// 写盘用 tmp + rename 原子替换，避免写一半掉电把文件搞坏。
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sendJSON, parseBody } from '../lib/util.js';

// 默认值：风险提示「每次都弹」是安全默认，别偷偷帮用户关掉
const DEFAULTS = {
  startup_warn_always: true,
};

// 白名单 + 类型规整。只认这里登记过的键，前端塞别的进来一律忽略，
// 免得这个文件被当成任意存储用。
const ALLOWED = {
  startup_warn_always: (v) => {
    if (v === true || v === 1 || v === '1' || v === 'true') return true;
    if (v === false || v === 0 || v === '0' || v === 'false') return false;
    return null;   // 非法值 → 不采纳
  },
};

function prefsFile() {
  const base = process.env.TRM_PKGVAR || '/vol3/@appdata/fnclearup';
  return join(base, 'data', 'ui-prefs.json');
}

/** 读偏好；文件不存在/损坏/权限不足 一律回默认值，不抛错。 */
export function loadPrefs() {
  const out = { ...DEFAULTS };
  try {
    const f = prefsFile();
    if (!existsSync(f)) return out;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    for (const k of Object.keys(ALLOWED)) {
      if (j && Object.prototype.hasOwnProperty.call(j, k)) {
        const v = ALLOWED[k](j[k]);
        if (v !== null) out[k] = v;
      }
    }
  } catch { /* 坏文件按默认值走 */ }
  return out;
}

function writePrefs(all) {
  const f = prefsFile();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
  renameSync(tmp, f);
}

// GET /api/prefs → { success, prefs: {...}, file }
export function handleGetPrefs(req, res) {
  return sendJSON(res, 200, {
    success: true,
    prefs: loadPrefs(),
    file: prefsFile(),
  });
}

// POST /api/prefs  body: { prefs: { startup_warn_always: bool } }
// 也接受扁平写法 { startup_warn_always: bool }，省得前端两种都试一遍
export async function handleSavePrefs(req, res) {
  const data = await parseBody(req);
  const patch = (data && data.prefs && typeof data.prefs === 'object') ? data.prefs : data;
  if (!patch || typeof patch !== 'object') {
    return sendJSON(res, 400, { success: false, error: '请求体必须是对象' });
  }

  const cur = loadPrefs();
  const applied = {};
  for (const k of Object.keys(ALLOWED)) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    const v = ALLOWED[k](patch[k]);
    if (v === null) {
      return sendJSON(res, 400, { success: false, error: `字段 ${k} 的值不合法` });
    }
    cur[k] = v;
    applied[k] = v;
  }
  if (Object.keys(applied).length === 0) {
    // 只传了白名单外的键：不报错，但要说清楚什么都没存，
    // 免得前端以为保存成功、下次进来发现没生效。
    return sendJSON(res, 200, {
      success: false,
      error: '没有可保存的字段（只接受：' + Object.keys(ALLOWED).join(', ') + '）',
      prefs: cur,
    });
  }

  try {
    writePrefs(cur);
  } catch (e) {
    return sendJSON(res, 500, { success: false, error: '保存失败: ' + e.message });
  }
  return sendJSON(res, 200, { success: true, prefs: cur, applied, file: prefsFile() });
}
