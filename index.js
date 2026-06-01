// ST-Saver + 增量同步中转客户端
//
// 工作模式：
//   1. 拦截酒馆所有 /api/chats/save 请求
//   2. 计算 line-level diff（只发变化的消息行给中转）
//   3. 中转→localhost→酒馆完成实际全量保存
//   4. 任何异常退化到原版全量保存（数据零丢失）
//
// 远程流量：从 5-46MB 降至几 KB ~ 几百 KB

import {
    characters,
    saveChatConditional,
    saveSettingsDebounced,
    this_chid,
    eventSource,
    event_types,
    getCurrentChatId,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE_NAME = 'st_saver';

const defaultSettings = Object.freeze({
    enabled: true,
    allowTimedSave: true,
    allowInterval: 10,

    // 增量同步开关与中转地址
    // 中转自己持有酒馆 cookie + csrf，浏览器请求中转时无需带任何认证。
    // 默认填本机 9527；远程访问时改成中转的 IP/域名:端口。
    relayEnabled: true,
    relayBaseUrl: 'http://127.0.0.1:9527',
    relayHealthcheckInterval: 30,    // 秒
    // 每次 delta 请求超时（秒）。中转处理大聊天耗时取决于行数：
    //   ~6MB / 1000 行  → 2-3 秒
    //   ~30MB / 5000 行 → 5-8 秒
    //   ~80MB / 1800 行 → 9-12 秒（特殊：每行很大）
    //   ~200MB         → 25-30 秒
    // 如果你聊天特别大（200MB+）或服务器配置低，调高这个数。
    relayTimeoutSec: 60,
    relayDebugLog: false,

    // ★ 数据丢失保护（防止坍缩的内存聊天覆盖磁盘完整记录）
    // 当本次要保存的聊天行数 < 基线(磁盘真相)行数 × shrinkGuardRatio 时，
    // 判定为"异常骤降"，直接阻止保存（丢弃坏数据，磁盘保持原样）。
    // 基线行数 < shrinkGuardMinBase 时不启用（避免新聊天误伤）。
    // 把 shrinkGuardRatio 设为 0 可关闭保护。需要一次性大量删除消息时临时调低。
    shrinkGuardRatio: 0.5,
    shrinkGuardMinBase: 20,
});

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...defaultSettings };
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwnProperty.call(extension_settings[MODULE_NAME], key)) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

function saveSettings() {
    saveSettingsDebounced();
}

// ─────────────────────────────────────────────────────────────────────
// hash：cyrb53 必须和中转 src/hash.js 完全一致
// ─────────────────────────────────────────────────────────────────────

function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const high = (h2 >>> 0) & 0x1fffff;
    const low = h1 >>> 0;
    return high.toString(16).padStart(6, '0') + low.toString(16).padStart(8, '0');
}

function computeChatHashes(chatArray) {
    const hashes = new Array(chatArray.length);
    for (let i = 0; i < chatArray.length; i++) {
        hashes[i] = cyrb53(JSON.stringify(chatArray[i]));
    }
    return hashes;
}

function fingerprintHashes(hashes) {
    return cyrb53(hashes.join('|') + '|' + hashes.length);
}

function logRelay(...args) {
    if (getSettings().relayDebugLog) console.log('[ST-Saver][Relay]', ...args);
}

// ─────────────────────────────────────────────────────────────────────
// settings 增量同步状态
// ─────────────────────────────────────────────────────────────────────

/**
 * 上次成功同步给中转的 settings 基线：
 *   { snapshot: 深拷贝的 settings 对象, fingerprint: string }
 * 用于算 field-level patch。
 */
let settingsBaseline = null;

/**
 * settings 保存串行锁：settings 保存很频繁，若并发会基于旧基线算 patch，
 * 导致中转频繁 409 + 全量重发。用 promise 链强制串行。
 */
/** @type {Promise<any>} */
let settingsSaveTail = Promise.resolve();
/**
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
function runSettingsSerial(fn) {
    const next = settingsSaveTail.then(fn, fn);
    // 失败也要释放队列，不传染
    settingsSaveTail = next.catch(() => undefined);
    return next;
}

/**
 * 稳定序列化（key 排序），跟中转 settings-store.js 的 stableStringify 一致。
 * 保证两端 fingerprint 算法相同。
 */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function settingsFingerprint(obj) {
    return cyrb53(stableStringify(obj));
}

/**
 * 算 settings 的字段级 patch（顶层 key + extension_settings 二级 key）。
 * 大部分 key 不变（比如 tavern_helper 那 6MB），只传变化的。
 *
 * @returns {{ patch, changedBytes, isTrivial } | null}
 *   null 表示无法增量（应走全量）
 */
function computeSettingsPatch(oldObj, newObj) {
    /** @type {{ top: Record<string,any>, ext: Record<string,any>, topRemoved: string[], extRemoved: string[] }} */
    const patch = { top: {}, ext: {}, topRemoved: [], extRemoved: [] };

    const oldKeys = new Set(Object.keys(oldObj));
    const newKeys = new Set(Object.keys(newObj));

    // 顶层字段对比（除 extension_settings 单独处理）
    for (const k of newKeys) {
        if (k === 'extension_settings') continue;
        if (!oldKeys.has(k) || stableStringify(oldObj[k]) !== stableStringify(newObj[k])) {
            patch.top[k] = newObj[k];
        }
    }
    for (const k of oldKeys) {
        if (k === 'extension_settings') continue;
        if (!newKeys.has(k)) patch.topRemoved.push(k);
    }

    // extension_settings 二级对比
    const oldExt = (oldObj.extension_settings && typeof oldObj.extension_settings === 'object') ? oldObj.extension_settings : {};
    const newExt = (newObj.extension_settings && typeof newObj.extension_settings === 'object') ? newObj.extension_settings : {};
    const oldExtKeys = new Set(Object.keys(oldExt));
    const newExtKeys = new Set(Object.keys(newExt));
    for (const k of newExtKeys) {
        if (!oldExtKeys.has(k) || stableStringify(oldExt[k]) !== stableStringify(newExt[k])) {
            patch.ext[k] = newExt[k];
        }
    }
    for (const k of oldExtKeys) {
        if (!newExtKeys.has(k)) patch.extRemoved.push(k);
    }

    const changedBytes = (() => {
        try { return new TextEncoder().encode(JSON.stringify(patch)).length; } catch { return 0; }
    })();

    const noChange = Object.keys(patch.top).length === 0
        && Object.keys(patch.ext).length === 0
        && patch.topRemoved.length === 0
        && patch.extRemoved.length === 0;

    return { patch, changedBytes, isTrivial: noChange };
}

// ─────────────────────────────────────────────────────────────────────
// 节流 toast：同 key 30 秒内最多弹一次，避免连续失败刷屏
// ─────────────────────────────────────────────────────────────────────
const TOAST_DEDUP_MS = 30 * 1000;
const lastToastAt = new Map();   // key → timestamp

function throttledToast(level, key, message, title = 'ST-Saver') {
    if (!window.toastr) return;
    const now = Date.now();
    const last = lastToastAt.get(key) || 0;
    if (now - last < TOAST_DEDUP_MS) return;
    lastToastAt.set(key, now);
    const fn = window.toastr[level] || window.toastr.info;
    fn(message, title);
}


// ─────────────────────────────────────────────────────────────────────
// 中转客户端
// ─────────────────────────────────────────────────────────────────────

// 必须在任何 relayFetch 调用前抓取 native fetch，否则我们自己后面会包它
const originalFetch = window.fetch;

function getRelayTimeoutMs() {
    const sec = parseInt(getSettings().relayTimeoutSec, 10);
    return Math.max(5, Number.isFinite(sec) ? sec : 60) * 1000;
}

const relayState = {
    healthy: false,
    lastCheck: 0,
};

/**
 * 包装 fetch，加超时控制；用 originalFetch 跳过我们自己的拦截器。
 *
 * 中转自己持有酒馆 cookie + csrf，浏览器无需带任何认证。
 * credentials: 'omit' 显式不带 cookie，避免跨域 preflight 复杂化。
 */
async function relayFetch(path, init = {}, timeoutMs = getRelayTimeoutMs()) {
    const settings = getSettings();
    const base = settings.relayBaseUrl.replace(/\/+$/, '');
    const url = base + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await originalFetch(url, {
            ...init,
            signal: controller.signal,
            credentials: 'omit',
        });
    } finally {
        clearTimeout(timer);
    }
}

async function checkRelayHealth(force = false) {
    const settings = getSettings();
    if (!settings.relayEnabled) {
        relayState.healthy = false;
        return false;
    }
    const now = Date.now();
    if (!force && now - relayState.lastCheck < settings.relayHealthcheckInterval * 1000) {
        return relayState.healthy;
    }
    relayState.lastCheck = now;
    try {
        const res = await relayFetch('/sync/health', { method: 'GET' }, 2000);
        relayState.healthy = res.ok;
    } catch (e) {
        relayState.healthy = false;
        logRelay('health check failed:', e?.message);
    }
    return relayState.healthy;
}

/**
 * 构造发给中转的请求头。
 *
 * 中转自己持有酒馆 cookie + csrf（启动时调 GET /csrf-token 取得），
 * 浏览器/扩展无需透传任何认证信息，简单干净。
 *
 * @param {*} [_originalHeaders]  保留参数槽位以备后续用，当前忽略
 */
function buildForwardHeaders(_originalHeaders) {
    return { 'Content-Type': 'application/json' };
}

// ─────────────────────────────────────────────────────────────────────
// 会话状态：每个聊天文件一份基线
// ─────────────────────────────────────────────────────────────────────

/**
 * 当前会话：
 *   sessionKey: 唯一标识（kind + id 或 avatar+file_name）
 *   kind: 'solo' | 'group'
 *   identity: { avatar_url, file_name, ch_name } 或 { id }
 *   lastSyncedHashes: string[]
 *   baselineFingerprint: string
 *   inited: boolean
 */
let currentSession = null;

function buildSessionKey(kind, identity) {
    if (kind === 'group') return `group::${identity.id}`;
    return `solo::${identity.avatar_url}::${identity.file_name}`;
}

function resolveCurrentIdentity() {
    // 群聊
    const groupId = (typeof window !== 'undefined' && window.SillyTavern?.getContext)
        ? window.SillyTavern.getContext().groupId
        : null;
    if (groupId) {
        const chatId = getCurrentChatId();
        if (!chatId) return null;
        return { kind: 'group', identity: { id: String(chatId) } };
    }

    // 单聊
    if (this_chid === undefined || !characters[this_chid]) return null;
    const ch = characters[this_chid];
    const fileName = ch.chat;
    if (!fileName) return null;
    return {
        kind: 'solo',
        identity: {
            avatar_url: ch.avatar,
            file_name: fileName,
            ch_name: ch.name,
        },
    };
}

function clearSession() {
    if (currentSession) logRelay('session cleared:', currentSession.sessionKey);
    currentSession = null;
}

/**
 * 主动从中转拉基线 hashes（CHAT_CHANGED 时调用）。
 * 这样第一次保存就能直接走增量，不再需要"首次走全量上传"。
 *
 * 流量：仅传 hashes 数组（1878 行 × 14 字符 ≈ 26KB），远小于聊天本身的几十 MB。
 */
async function initBaselineFromRelay() {
    const settings = getSettings();
    if (!settings.relayEnabled) return null;

    const resolved = resolveCurrentIdentity();
    if (!resolved) {
        logRelay('initBaseline: no identity yet, skip');
        return null;
    }

    const ok = await checkRelayHealth(false);
    if (!ok) {
        logRelay('initBaseline: relay unhealthy, skip (next save will fall back)');
        return null;
    }

    const sessionKey = buildSessionKey(resolved.kind, resolved.identity);
    const body = {
        kind: resolved.kind,
        ...resolved.identity,
    };

    let res;
    try {
        res = await relayFetch('/sync/init', {
            method: 'POST',
            headers: buildForwardHeaders(),
            body: JSON.stringify(body),
        });
    } catch (err) {
        logRelay('initBaseline: fetch failed:', err?.message);
        return null;
    }

    if (!res.ok) {
        logRelay('initBaseline: relay returned', res.status);
        return null;
    }

    const json = await res.json().catch(() => null);
    if (!json || !Array.isArray(json.hashes) || !json.baselineFingerprint) {
        logRelay('initBaseline: malformed response');
        return null;
    }

    currentSession = {
        sessionKey,
        kind: resolved.kind,
        identity: resolved.identity,
        lastSyncedHashes: json.hashes,
        baselineFingerprint: json.baselineFingerprint,
        inited: true,
    };
    logRelay(`initBaseline: ok sessionKey=${sessionKey} len=${json.length} fp=${json.baselineFingerprint}`);
    return currentSession;
}


// ─────────────────────────────────────────────────────────────────────
// 基线建立 / 重建
// ─────────────────────────────────────────────────────────────────────

/**
 * 用中转返回的磁盘 hashes 重建基线（mismatch 后调用）。
 */
function rebuildBaselineFromRelay(payload) {
    if (!currentSession) return null;
    if (!Array.isArray(payload?.hashes) || !payload?.baselineFingerprint) return null;
    currentSession.lastSyncedHashes = payload.hashes;
    currentSession.baselineFingerprint = payload.baselineFingerprint;
    currentSession.inited = true;
    logRelay('baseline rebuilt from relay:', currentSession.sessionKey, 'len=', payload.hashes.length, 'fp=', payload.baselineFingerprint);
    return currentSession;
}

// ─────────────────────────────────────────────────────────────────────
// 数据丢失保护：检测聊天行数异常骤降
// ─────────────────────────────────────────────────────────────────────

/**
 * 判断"新聊天行数"相对"磁盘基线行数"是否异常骤降。
 * 骤降通常意味着内存里的 chat 没加载完整（页面重载竞态 / 脚本异常坍缩），
 * 此时绝不能让它覆盖磁盘上的完整记录。
 *
 * @param {number} baseLength  基线（磁盘真相）行数
 * @param {number} newLength   本次要保存的行数
 * @returns {{ blocked: boolean, baseLength: number, newLength: number, ratio: number }}
 */
function checkShrinkGuard(baseLength, newLength) {
    const cfg = getSettings();
    const ratioThreshold = Number(cfg.shrinkGuardRatio);
    const minBase = Number(cfg.shrinkGuardMinBase);
    const result = { blocked: false, baseLength, newLength, ratio: ratioThreshold };

    // 关闭保护
    if (!Number.isFinite(ratioThreshold) || ratioThreshold <= 0) return result;
    // 基线太小（新聊天 / 刚开局）不启用，避免误伤正常增长
    if (!Number.isFinite(baseLength) || baseLength < (Number.isFinite(minBase) ? minBase : 20)) return result;

    // 新行数 < 基线 × 阈值 → 判定骤降
    if (newLength < baseLength * ratioThreshold) {
        result.blocked = true;
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────
// diff 计算
// ─────────────────────────────────────────────────────────────────────

function computeDelta(oldHashes, newChat) {
    const newHashes = computeChatHashes(newChat);
    const changes = [];
    const maxLen = Math.max(oldHashes.length, newHashes.length);
    for (let i = 0; i < maxLen; i++) {
        if (i >= newHashes.length) break;          // 被截断的尾部不需要 push 到 changes
        if (oldHashes[i] !== newHashes[i]) {
            changes.push({ index: i, message: newChat[i] });
        }
    }
    return {
        changes,
        newHashes,
        newFingerprint: fingerprintHashes(newHashes),
        oldLength: oldHashes.length,
        newLength: newHashes.length,
    };
}

// ─────────────────────────────────────────────────────────────────────
// delta 上报
// ─────────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, shrink?: { baseLength: number, newLength: number } }>}
 */
async function postDelta(originalHeaders, chatToSave) {
    if (!currentSession || !currentSession.inited) {
        return { ok: false, reason: 'no_session' };
    }

    const session = currentSession;
    const delta = computeDelta(session.lastSyncedHashes, chatToSave);

    // ★ 数据丢失保护：行数异常骤降 → 拒绝保存
    // 场景：手机端页面重载竞态，内存 chat 坍缩成几行，若放行会把磁盘几十 MB 覆盖成几 B。
    // 这里 oldLength = 上次同步的磁盘真相行数，newLength = 本次内存行数。
    const guard = checkShrinkGuard(delta.oldLength, delta.newLength);
    if (guard.blocked) {
        logRelay(`⛔ shrink guard: base=${delta.oldLength} new=${delta.newLength}, BLOCK to protect disk`);
        return { ok: false, reason: 'shrink_guard', shrink: guard };
    }

    // 没有任何变化
    if (delta.changes.length === 0 && delta.oldLength === delta.newLength) {
        logRelay('no changes, skip');
        return { ok: true };
    }

    // 变化超过 50% → 认为 diff 没意义，回退全量
    if (delta.changes.length > Math.max(delta.newLength, 1) * 0.5) {
        logRelay(`changes too many (${delta.changes.length}/${delta.newLength}), fallback to full save`);
        return { ok: false, reason: 'too_many_changes' };
    }

    const payload = {
        kind: session.kind,
        ...session.identity,
        sessionKey: session.sessionKey,
        baseLength: delta.oldLength,
        baselineFingerprint: session.baselineFingerprint,
        newLength: delta.newLength,
        changes: delta.changes,
    };

    let res;
    try {
        res = await relayFetch('/sync/delta', {
            method: 'POST',
            headers: buildForwardHeaders(originalHeaders),
            body: JSON.stringify(payload),
        });
    } catch (err) {
        logRelay('delta fetch failed:', err?.message);
        return { ok: false, reason: 'network' };
    }

    if (res.ok) {
        const json = await res.json().catch(() => ({}));
        // 用本次的 newHashes 推进基线
        session.lastSyncedHashes = delta.newHashes;
        session.baselineFingerprint = json.baselineFingerprint || delta.newFingerprint;
        logRelay(`delta ok changes=${delta.changes.length} len=${delta.newLength} fp=${session.baselineFingerprint}`);
        return { ok: true };
    }

    // 409 = 基线过期，中转返回了真实磁盘 hashes
    if (res.status === 409) {
        const json = await res.json().catch(() => null);
        // ★ 中转的骤降保护 409：这是数据保护信号，绝不能 rebuild+retry 或走全量
        if (json && json.error === 'shrink_guard') {
            logRelay(`⛔ relay shrink guard 409: disk=${json.length} → BLOCK, protect disk`);
            return {
                ok: false,
                reason: 'shrink_guard',
                shrink: { baseLength: json.length, newLength: delta.newLength },
            };
        }
        if (json && Array.isArray(json.hashes)) {
            rebuildBaselineFromRelay(json);
            // 用纠正后的基线重新算并重发一次（仅一次重试，避免无限循环）
            const retry = computeDelta(session.lastSyncedHashes, chatToSave);
            if (retry.changes.length === 0 && retry.oldLength === retry.newLength) {
                logRelay('after rebuild: no changes');
                return { ok: true };
            }
            if (retry.changes.length > Math.max(retry.newLength, 1) * 0.5) {
                return { ok: false, reason: 'too_many_changes_after_rebuild' };
            }
            try {
                const res2 = await relayFetch('/sync/delta', {
                    method: 'POST',
                    headers: buildForwardHeaders(originalHeaders),
                    body: JSON.stringify({
                        kind: session.kind,
                        ...session.identity,
                        sessionKey: session.sessionKey,
                        baseLength: retry.oldLength,
                        baselineFingerprint: session.baselineFingerprint,
                        newLength: retry.newLength,
                        changes: retry.changes,
                    }),
                });
                if (res2.ok) {
                    const j2 = await res2.json().catch(() => ({}));
                    session.lastSyncedHashes = retry.newHashes;
                    session.baselineFingerprint = j2.baselineFingerprint || retry.newFingerprint;
                    logRelay('delta retry ok');
                    return { ok: true };
                }
            } catch (e) {
                logRelay('delta retry failed:', e?.message);
            }
        }
        return { ok: false, reason: 'baseline_outdated' };
    }

    logRelay('delta failed status:', res.status);
    return { ok: false, reason: 'server_error_' + res.status };
}


// ─────────────────────────────────────────────────────────────────────
// 拦截 saveChat 的 fetch（核心入口）
// ─────────────────────────────────────────────────────────────────────

/**
 * 从原始 saveChat 请求里取出 chatToSave 数组（含 chat[0] 头部）。
 */
function extractChatToSaveFromRequest(url, init) {
    try {
        if (!init?.body) return null;
        let body = init.body;
        if (body instanceof Blob) return null; // 不处理 blob
        if (typeof body !== 'string') {
            // 极个别 case 可能是 BodyInit，跳过
            return null;
        }
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed?.chat)) return parsed;
        return null;
    } catch (e) {
        logRelay('extract chat failed:', e?.message);
        return null;
    }
}

/**
 * 用增量同步处理 saveSettings（/api/settings/save）。
 * 把整个 settings 对象 diff 成字段级 patch 发给中转。
 * 成功返回 Response，失败返回 null（外层走原版全量）。
 */
async function handleSettingsSave(url, init) {
    const cfg = getSettings();
    if (!cfg.relayEnabled) return null;

    // 取出本次要保存的完整 settings 对象
    let newSettings;
    try {
        if (!init?.body || typeof init.body !== 'string') return null;
        newSettings = JSON.parse(init.body);
        if (!newSettings || typeof newSettings !== 'object') return null;
    } catch (e) {
        logRelay('settings: parse body failed:', e?.message);
        return null;
    }

    const ok = await checkRelayHealth(false);
    if (!ok) {
        logRelay('settings: relay unhealthy, fallback to full');
        return null;
    }

    const newFp = settingsFingerprint(newSettings);

    // 没有基线 → 走全量 full（建立基线）
    if (!settingsBaseline) {
        try {
            const res = await relayFetch('/sync/settings/full', {
                method: 'POST',
                headers: buildForwardHeaders(),
                body: JSON.stringify({ settings: newSettings }),
            });
            if (res.ok) {
                const json = await res.json().catch(() => ({}));
                settingsBaseline = {
                    snapshot: JSON.parse(JSON.stringify(newSettings)),
                    fingerprint: json.baselineFingerprint || newFp,
                };
                logRelay('settings: full sync established baseline, fp=', settingsBaseline.fingerprint);
                return new Response(JSON.stringify({ result: 'ok' }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
        } catch (e) {
            logRelay('settings: full sync failed:', e?.message);
        }
        return null;
    }

    // 有基线 → 算 patch
    const diff = computeSettingsPatch(settingsBaseline.snapshot, newSettings);
    if (!diff) return null;
    if (diff.isTrivial) {
        logRelay('settings: no changes, skip');
        return new Response(JSON.stringify({ result: 'ok' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        });
    }

    try {
        const res = await relayFetch('/sync/settings/delta', {
            method: 'POST',
            headers: buildForwardHeaders(),
            body: JSON.stringify({
                baseFingerprint: settingsBaseline.fingerprint,
                patch: diff.patch,
            }),
        });

        if (res.ok) {
            const json = await res.json().catch(() => ({}));
            settingsBaseline = {
                snapshot: JSON.parse(JSON.stringify(newSettings)),
                fingerprint: json.baselineFingerprint || newFp,
            };
            logRelay(`settings: delta ok changedBytes=${diff.changedBytes} fp=${settingsBaseline.fingerprint}`);
            return new Response(JSON.stringify({ result: 'ok' }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 409：中转基线过期（中转重启/多端）→ 重发完整
        if (res.status === 409) {
            logRelay('settings: 409, re-establishing baseline via full sync');
            settingsBaseline = null;
            const res2 = await relayFetch('/sync/settings/full', {
                method: 'POST',
                headers: buildForwardHeaders(),
                body: JSON.stringify({ settings: newSettings }),
            });
            if (res2.ok) {
                const j2 = await res2.json().catch(() => ({}));
                settingsBaseline = {
                    snapshot: JSON.parse(JSON.stringify(newSettings)),
                    fingerprint: j2.baselineFingerprint || newFp,
                };
                logRelay('settings: re-sync ok, fp=', settingsBaseline.fingerprint);
                return new Response(JSON.stringify({ result: 'ok' }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
        }
    } catch (e) {
        logRelay('settings: delta failed:', e?.message);
    }
    return null;
}

/**
 * 用增量同步处理 saveChat。
 * 失败时返回 null，让外层走原版全量。
 */
async function handleIncrementalSave(url, init) {
    const settings = getSettings();
    if (!settings.relayEnabled) return null;

    const parsedBody = extractChatToSaveFromRequest(url, init);
    if (!parsedBody) return null;

    const chatToSave = parsedBody.chat;

    // 没有基线 → 第一次拦截到。
    // ★ 不能盲目用内存 chat 建基线后走全量（手机端这正是坍缩窗口，会覆盖磁盘）。
    // 先尝试从中转拉磁盘真相，用磁盘行数对内存行数做骤降保护：
    //   - 拉到磁盘基线且行数正常 → 用磁盘基线，继续走增量（不全量覆盖）
    //   - 拉到磁盘基线但内存骤降 → 拦截，保护磁盘
    //   - 中转不可达 → 保持原行为（用内存建基线 + 全量），无磁盘真相时无法保护
    if (!currentSession || !currentSession.inited) {
        const resolved = resolveCurrentIdentity();
        if (!resolved) return null;

        const healthy = await checkRelayHealth(false);
        if (healthy) {
            const based = await initBaselineFromRelay();
            if (based && based.inited) {
                // 用磁盘真相做骤降保护
                const guard = checkShrinkGuard(based.lastSyncedHashes.length, chatToSave.length);
                if (guard.blocked) {
                    logRelay(`⛔ first-save shrink guard: disk=${guard.baseLength} new=${guard.newLength}, BLOCK`);
                    throttledToast(
                        'error',
                        'shrink_guard',
                        `⛔ 检测到聊天异常变短（${guard.baseLength}→${guard.newLength} 条），已拦截本次保存以保护磁盘记录。`
                        + `请刷新页面确认聊天完整后再继续。`,
                        'ST-Saver 数据保护',
                    );
                    currentSession = null; // 作废，下次重新对齐
                    return new Response(JSON.stringify({ result: 'ok', guarded: true }), {
                        status: 200, headers: { 'Content-Type': 'application/json' },
                    });
                }
                // 行数正常 → 直接走下面的增量路径（已有 currentSession=磁盘基线）
            } else {
                // 拉基线失败 → 用内存建基线 + 全量兜底（无磁盘真相，保持原行为）
                const sessionKey = buildSessionKey(resolved.kind, resolved.identity);
                const hashes = computeChatHashes(chatToSave);
                currentSession = {
                    sessionKey,
                    kind: resolved.kind,
                    identity: resolved.identity,
                    lastSyncedHashes: hashes,
                    baselineFingerprint: fingerprintHashes(hashes),
                    inited: true,
                };
                logRelay('first save: relay init failed, in-place baseline, fall through to full save');
                return null;
            }
        } else {
            // 中转不可达 → 原行为
            const sessionKey = buildSessionKey(resolved.kind, resolved.identity);
            const hashes = computeChatHashes(chatToSave);
            currentSession = {
                sessionKey,
                kind: resolved.kind,
                identity: resolved.identity,
                lastSyncedHashes: hashes,
                baselineFingerprint: fingerprintHashes(hashes),
                inited: true,
            };
            logRelay('first save: relay unhealthy, in-place baseline, fall through to full save');
            return null;
        }
    }
    const result = await postDelta(init?.headers, chatToSave);
    if (result.ok) {
        // 增量成功，伪造一个 200 响应让酒馆继续
        return new Response(JSON.stringify({ result: 'ok' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ★ 数据丢失保护命中：绝不能走全量兜底（全量会用坍缩的 chat 覆盖磁盘）
    // 这里直接伪造一个 200 让酒馆以为存好了（磁盘其实保持完整），并强力告警。
    // 同时让基线作废，下次保存重新从磁盘拉真相对齐。
    if (result.reason === 'shrink_guard') {
        const s = result.shrink || { baseLength: '?', newLength: '?' };
        logRelay(`⛔ shrink guard active: discarded collapsed save (base=${s.baseLength} new=${s.newLength}), disk protected`);
        throttledToast(
            'error',
            'shrink_guard',
            `⛔ 检测到聊天异常变短（${s.baseLength}→${s.newLength} 条），已拦截本次保存以保护磁盘记录。`
            + `请刷新页面确认聊天完整后再继续。`,
            'ST-Saver 数据保护',
        );
        // 基线作废：下次 saveChat 会重新拉磁盘真相
        currentSession = null;
        return new Response(JSON.stringify({ result: 'ok', guarded: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    logRelay('delta failed, fallback to full save:', result.reason);
    // delta 失败 → 让外层用 originalFetch 走全量保存
    // 同时让基线作废，下次重建
    if (result.reason === 'baseline_outdated' || result.reason === 'too_many_changes_after_rebuild') {
        // 走全量保存意味着这次磁盘会被这份 chatToSave 完全覆盖
        // 因此可以直接把当前 chatToSave 当新基线
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────
// 全局 fetch 拦截
// ─────────────────────────────────────────────────────────────────────

window.fetch = function (url, init) {
    const settings = getSettings();
    if (!settings.enabled) {
        return originalFetch.apply(this, arguments);
    }

    const urlString = url.toString();
    const isSoloSave = urlString.includes('/api/chats/save');
    const isGroupSave = urlString.includes('/api/chats/group/save');
    const isSettingsSave = urlString.includes('/api/settings/save');

    // ────────────────────────────────────────────────────────────────
    // settings 增量同步：拦截 /api/settings/save
    // settings 文件常被撑到几 MB（脚本库/正则等），且保存极频繁。
    // 增量后单次从 ~9MB 降到 KB。失败回退原版全量。
    // ────────────────────────────────────────────────────────────────
    if (isSettingsSave && settings.relayEnabled) {
        return (async () => {
            try {
                // 串行化：避免并发 saveSettings 基于旧基线算 patch
                const handled = await runSettingsSerial(() => handleSettingsSave(urlString, init));
                if (handled) {
                    logRelay('settings save → incremental ok');
                    return handled;
                }
            } catch (err) {
                console.error('[ST-Saver] settings incremental error, fallback to full:', err);
            }
            // 回退原版全量
            const resp = await originalFetch.call(window, url, init);
            if (resp.ok) {
                // 全量成功（绕过了中转，中转内存基线已过期）→
                // 把扩展基线置 null，强制下次保存走 full 主动与中转重新对齐
                settingsBaseline = null;
                logRelay('settings: full fallback ok, baseline reset (next save will re-sync)');
                throttledToast('warning', 'settings_fallback',
                    '设置增量同步失败，已用全量兜底（流量较大）。请检查中转服务。');
            } else {
                throttledToast('error', 'settings_save_failed', `设置保存失败: ${resp.statusText}`);
            }
            return resp;
        })();
    }

    if (!isSoloSave && !isGroupSave) {
        return originalFetch.apply(this, arguments);
    }

    // ────────────────────────────────────────────────────────────────
    // 模式 1：增量同步开启 → 每次 saveChat 都直接走增量（不再屏蔽）
    //
    // 增量保存本身就是 KB 级流量，没必要再"攒批 + 定时放行"。
    // 失败自动回退到原版全量。
    //
    // toast 策略：
    //   - 自动保存（无 manual intent）：成功静默，仅失败弹
    //   - 手动按钮触发（有 manual intent）：成功也弹（用户主动需反馈）
    // ────────────────────────────────────────────────────────────────
    if (settings.relayEnabled) {
        // 偷看一下 intent 是不是 manual（不消费），决定 toast 策略
        const peekedIntent = pendingSaveIntent;
        const isManual = peekedIntent && peekedIntent.type === 'manual'
            && Date.now() <= peekedIntent.expiresAt;
        // 消费 intent（避免它泄漏给后续请求）
        consumeSaveIntent();

        return (async () => {
            // 先尝试增量
            let incrementalFailReason = null;
            try {
                const incremental = await handleIncrementalSave(urlString, init);
                if (incremental) {
                    logRelay('auto save → incremental ok');
                    if (isManual) {
                        throttledToast('success', 'manual_inc_ok', '聊天保存成功（增量）');
                    }
                    return incremental;
                }
                // handleIncrementalSave 返回 null 但没抛错 = 内部决定走全量
                // （比如：中转不健康 / 首次没基线 / changes 太多）
                incrementalFailReason = 'fell_through';
            } catch (err) {
                console.error('[ST-Saver] incremental save error, fallback to full:', err);
                incrementalFailReason = err?.message || 'unknown';
            }

            // 增量失败 → 全量兜底
            const resp = await originalFetch.call(window, url, init);
            if (resp.ok) {
                // 用本次 chat 重建基线，保证下次增量是准的
                try {
                    const parsed = extractChatToSaveFromRequest(urlString, init);
                    if (parsed) {
                        const resolved = resolveCurrentIdentity();
                        if (resolved) {
                            const sessionKey = buildSessionKey(resolved.kind, resolved.identity);
                            const hashes = computeChatHashes(parsed.chat);
                            currentSession = {
                                sessionKey,
                                kind: resolved.kind,
                                identity: resolved.identity,
                                lastSyncedHashes: hashes,
                                baselineFingerprint: fingerprintHashes(hashes),
                                inited: true,
                            };
                            logRelay('baseline updated after full save fallback', sessionKey, 'len=', hashes.length);
                        }
                    }
                } catch (e) { logRelay('post-fallback baseline update failed:', e?.message); }

                // 关键：明确告诉用户走了全量保存（流量大），不要让用户以为一切正常
                if (isManual) {
                    throttledToast('success', 'manual_full_ok', '聊天保存成功（全量兜底）');
                }
                // 即使是自动保存场景，也要告警一次：增量失败导致退化为全量上传
                throttledToast(
                    'warning',
                    'fallback_active',
                    `增量保存失败，已用全量兜底（流量较大）。原因：${incrementalFailReason || 'unknown'}。请检查中转服务。`,
                );
            } else {
                throttledToast('error', 'save_failed', `聊天保存失败: ${resp.statusText}`);
            }
            return resp;
        })();
    }

    // ────────────────────────────────────────────────────────────────
    // 模式 2：增量同步关闭 → 走原版"屏蔽 + 手动按钮 / 定时放行 + 全量"逻辑
    // ────────────────────────────────────────────────────────────────
    const saveIntent = consumeSaveIntent();

    // 没有"放行意图" → 屏蔽这次自动保存（manual saver 原本行为）
    if (!saveIntent) {
        logRelay('blocked auto save');
        return Promise.resolve(new Response(
            JSON.stringify({ status: 'ok', message: 'Blocked by ST-Saver' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
    }

    // 有放行意图 → 优先走增量，失败则走原版全量
    return (async () => {
        try {
            const incremental = await handleIncrementalSave(urlString, init);
            if (incremental) {
                if (saveIntent.type === 'manual' && window.toastr) {
                    window.toastr.success('聊天保存成功（增量）', 'ST-Saver');
                } else if (saveIntent.type === 'timed' && window.toastr) {
                    window.toastr.success(`定时自动保存成功（增量，间隔: ${settings.allowInterval}分钟）`, 'ST-Saver');
                }
                if (saveIntent.type === 'manual' || saveIntent.type === 'timed') {
                    resetTimer(saveIntent.type + ' incremental save allowed');
                }
                return incremental;
            }
        } catch (err) {
            console.error('[ST-Saver] incremental save error, fallback:', err);
        }

        // 走原版全量
        const resp = await originalFetch.call(window, url, init);
        if (resp.ok) {
            // 全量保存成功 → 用本次 chatToSave 重建基线（保证下一次增量是准的）
            try {
                const parsed = extractChatToSaveFromRequest(urlString, init);
                if (parsed) {
                    const resolved = resolveCurrentIdentity();
                    if (resolved) {
                        const sessionKey = buildSessionKey(resolved.kind, resolved.identity);
                        const hashes = computeChatHashes(parsed.chat);
                        currentSession = {
                            sessionKey,
                            kind: resolved.kind,
                            identity: resolved.identity,
                            lastSyncedHashes: hashes,
                            baselineFingerprint: fingerprintHashes(hashes),
                            inited: true,
                        };
                        logRelay('baseline updated after full save', sessionKey, 'len=', hashes.length);
                    }
                }
            } catch (e) { logRelay('post-full-save baseline update failed:', e?.message); }

            if (saveIntent.type === 'manual' && window.toastr) {
                window.toastr.success('聊天保存成功', 'ST-Saver');
            } else if (saveIntent.type === 'timed' && window.toastr) {
                window.toastr.success(`定时自动保存成功（间隔: ${settings.allowInterval}分钟）`, 'ST-Saver');
            }
            if (saveIntent.type === 'manual' || saveIntent.type === 'timed') {
                resetTimer(saveIntent.type + ' full save allowed');
            }
        } else {
            if (window.toastr) window.toastr.error(`聊天保存失败: ${resp.statusText}`, 'ST-Saver');
            if (saveIntent.type === 'timed') {
                scheduleTimedSave(Math.min(getTimedSaveIntervalMs(), TIMED_SAVE_RETRY_MS));
            }
        }
        return resp;
    })();
};


// ─────────────────────────────────────────────────────────────────────
// UI / 定时保存（继承原扩展逻辑）
// ─────────────────────────────────────────────────────────────────────

let timedSaveTimer = null;
let pendingSaveIntent = null;

const SAVE_INTENT_TTL_MS = 10 * 1000;
const TIMED_SAVE_RETRY_MS = 30 * 1000;

function getTimedSaveIntervalMs() {
    const intervalMinutes = parseInt(getSettings().allowInterval, 10) || defaultSettings.allowInterval;
    return Math.max(1, intervalMinutes) * 60 * 1000;
}

function clearTimedSaveTimer() {
    if (timedSaveTimer) {
        clearTimeout(timedSaveTimer);
        timedSaveTimer = null;
    }
}

function scheduleTimedSave(delayMs = getTimedSaveIntervalMs()) {
    clearTimedSaveTimer();
    const settings = getSettings();
    if (!settings.enabled || !settings.allowTimedSave) return;
    // 增量同步开启时，每次 saveChat 都即时放行了，定时器没意义
    if (settings.relayEnabled) return;
    timedSaveTimer = setTimeout(() => triggerTimedSave(), Math.max(1000, delayMs));
}

function beginSaveIntent(type) {
    const intent = { type, expiresAt: Date.now() + SAVE_INTENT_TTL_MS };
    pendingSaveIntent = intent;
    return intent;
}

function clearSaveIntent(intent = pendingSaveIntent) {
    if (pendingSaveIntent === intent) pendingSaveIntent = null;
}

function consumeSaveIntent() {
    const intent = pendingSaveIntent;
    pendingSaveIntent = null;
    if (!intent) return null;
    if (Date.now() > intent.expiresAt) return null;
    return intent;
}

function resetTimer(reason = '') {
    console.log(`[ST-Saver] Auto-save timer reset${reason ? `: ${reason}` : ''}.`);
    scheduleTimedSave();
}

async function triggerTimedSave() {
    const settings = getSettings();
    if (!settings.enabled || !settings.allowTimedSave) {
        clearTimedSaveTimer();
        clearSaveIntent();
        return;
    }
    const intent = beginSaveIntent('timed');
    try {
        await saveChatConditional();
    } catch (error) {
        console.error('[ST-Saver] Timed save error:', error);
        if (window.toastr) window.toastr.error(`定时自动保存触发失败: ${error.message}`, 'ST-Saver');
    } finally {
        if (pendingSaveIntent === intent) {
            clearSaveIntent(intent);
            scheduleTimedSave(Math.min(getTimedSaveIntervalMs(), TIMED_SAVE_RETRY_MS));
        }
    }
}

// 设置面板 HTML
function renderSettingsHtml() {
    const s = getSettings();
    return `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>ST-Saver — 手动保存 + 增量同步</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input type="checkbox" id="st_saver_enabled" ${s.enabled ? 'checked' : ''}>
                    <span>启用插件</span>
                </label>
                <div class="st_saver_hint" style="font-size: smaller; opacity: 0.8;">启用后，SillyTavern的自动保存将被屏蔽，仅在手动保存或定时放行时上传。</div>

                <fieldset id="st_saver_timed_options" ${(!s.enabled || s.relayEnabled) ? 'disabled' : ''}>
                    <hr>
                    <label class="checkbox_label">
                        <input type="checkbox" id="st_saver_allow_timed_save" ${s.allowTimedSave ? 'checked' : ''}>
                        <span>启用定时允许自动保存</span>
                    </label>
                    <div class="st_saver_hint" style="font-size: smaller; opacity: 0.8;">
                        ${s.relayEnabled
                            ? '（增量同步已启用，每次保存都走增量，无需定时放行）'
                            : '每隔一段时间放行一次自动保存，避免忘记手动保存导致大量丢失'}
                    </div>
                    <label for="st_saver_allow_interval">间隔时间（分钟）</label>
                    <input type="number" id="st_saver_allow_interval" value="${s.allowInterval}" min="1" class="text_pole">
                </fieldset>

                <hr>
                <h4>增量同步（远程流量优化）</h4>
                <label class="checkbox_label">
                    <input type="checkbox" id="st_saver_relay_enabled" ${s.relayEnabled ? 'checked' : ''}>
                    <span>启用增量同步（需要本地中转 st-save-relay 在跑）</span>
                </label>
                <div class="st_saver_hint" style="font-size: smaller; opacity: 0.8;">
                    远程流量从全量 (5-46MB) 降至 KB 级。中转不可用时自动退化到原版全量保存。
                </div>
                <label for="st_saver_relay_url">中转地址</label>
                <input type="text" id="st_saver_relay_url" value="${s.relayBaseUrl}" class="text_pole" placeholder="http://192.168.x.x:9527">
                <div class="st_saver_hint" style="font-size: smaller; opacity: 0.8;">
                    远程访问时填中转所在服务器的 IP/域名:9527。中转和酒馆同机部署，自己持有 cookie+csrf，浏览器无需带任何认证。
                </div>
                <label for="st_saver_relay_timeout">单次请求超时（秒）</label>
                <input type="number" id="st_saver_relay_timeout" value="${s.relayTimeoutSec}" min="5" max="600" class="text_pole">
                <div class="st_saver_hint" style="font-size: smaller; opacity: 0.8;">
                    中转处理一次保存的耗时取决于聊天大小。10-30MB 默认 60 秒足够；超大聊天（200MB+）调高到 120-300 秒。
                </div>
                <label class="checkbox_label">
                    <input type="checkbox" id="st_saver_relay_debug" ${s.relayDebugLog ? 'checked' : ''}>
                    <span>开启增量同步调试日志</span>
                </label>
                <div id="st_saver_relay_status" style="margin-top: 8px; font-size: smaller; opacity: 0.85;"></div>
            </div>
        </div>
    `;
}

function refreshRelayStatusUi() {
    const el = $('#st_saver_relay_status');
    if (!el.length) return;
    const s = getSettings();
    if (!s.relayEnabled) {
        el.html('<span style="color: #888;">⏸ 增量同步未启用</span>');
        return;
    }
    el.html('<span>⏳ 检查中转连接…</span>');
    checkRelayHealth(true).then(ok => {
        if (ok) {
            el.html('<span style="color: #4caf50;">✓ 中转在线</span>');
        } else {
            el.html('<span style="color: #f44336;">✗ 中转不可达，将自动退化为全量保存</span>');
        }
    });
}

function bindSettingsEvents() {
    const s = () => getSettings();
    const save = () => saveSettings();

    $(document).on('change', '#st_saver_enabled', function () {
        s().enabled = $(this).prop('checked');
        save();
        $('#st_saver_timed_options').prop('disabled', !s().enabled);
        updateButtonState();
        clearSaveIntent();
        if (s().enabled) resetTimer('plugin enabled');
        else clearTimedSaveTimer();
    });

    $(document).on('change', '#st_saver_allow_timed_save', function () {
        s().allowTimedSave = $(this).prop('checked');
        save();
        clearSaveIntent();
        if (s().allowTimedSave) resetTimer('timed save enabled');
        else clearTimedSaveTimer();
    });
    $(document).on('input', '#st_saver_allow_interval', function () {
        s().allowInterval = parseInt($(this).val()) || defaultSettings.allowInterval;
        save();
        resetTimer('interval updated');
    });

    $(document).on('change', '#st_saver_relay_enabled', function () {
        s().relayEnabled = $(this).prop('checked');
        save();
        // 增量开启 → 关掉定时；关闭 → 恢复定时
        if (s().relayEnabled) {
            clearTimedSaveTimer();
        } else {
            resetTimer('relay disabled, timer back');
        }
        // 重新渲染设置面板让 fieldset disabled 状态正确
        const $container = $('#st_saver_container');
        if ($container.length) $container.html(renderSettingsHtml());
        refreshRelayStatusUi();
    });
    $(document).on('change', '#st_saver_relay_url', function () {
        s().relayBaseUrl = String($(this).val() || '').trim() || defaultSettings.relayBaseUrl;
        save();
        relayState.lastCheck = 0;
        refreshRelayStatusUi();
    });
    $(document).on('input', '#st_saver_relay_timeout', function () {
        const v = parseInt($(this).val(), 10);
        s().relayTimeoutSec = Math.max(5, Math.min(600, Number.isFinite(v) ? v : defaultSettings.relayTimeoutSec));
        save();
    });
    $(document).on('change', '#st_saver_relay_debug', function () {
        s().relayDebugLog = $(this).prop('checked');
        save();
    });
}

function addSaveButton() {
    if ($('#st_saver_button').length) return;

    let extensionsMenu = $('#extensionsMenu');
    if (!extensionsMenu.length) {
        const optionsMenu = $('#options');
        if (!optionsMenu.length) return;
        extensionsMenu = optionsMenu;
    }

    const saveButton = $('<div id="st_saver_button" class="list-group-item flex-container flexGap5 interactable tavern-helper-shortcut-item" title="Save the current chat manually (ST-Saver, incremental)"><div class="fa-solid fa-save extensionsMenuExtensionButton"></div><span>保存聊天 (ST-Saver)</span></div>');

    saveButton.on('click', async () => {
        const intent = beginSaveIntent('manual');
        try {
            await saveChatConditional();
        } catch (error) {
            console.error('[ST-Saver] manual save error:', error);
            if (window.toastr) window.toastr.error(`Could not initiate save: ${error.message}`, 'ST-Saver');
        } finally {
            clearSaveIntent(intent);
        }
    });
    extensionsMenu.append(saveButton);
}

function removeSaveButton() {
    $('#st_saver_button').remove();
}

function updateButtonState() {
    if (getSettings().enabled) {
        const buttonInterval = setInterval(() => {
            if ($('#extensionsMenu').length || $('#options').length) {
                addSaveButton();
                clearInterval(buttonInterval);
            }
        }, 500);
    } else {
        removeSaveButton();
    }
}

// ─────────────────────────────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────────────────────────────

console.log('[ST-Saver] loading + relay client mode');

$(document).ready(function () {
    const extensionsSettings = $('#extensions_settings');
    if (extensionsSettings.length) {
        extensionsSettings.append(`<div id="st_saver_container">${renderSettingsHtml()}</div>`);
        bindSettingsEvents();
        refreshRelayStatusUi();
    }

    updateButtonState();
    resetTimer('plugin initialized');

    // 启动时如果已经在某个聊天里，主动建立基线（CHAT_CHANGED 在加载完成前已经触发过）
    setTimeout(() => {
        if (!currentSession) {
            initBaselineFromRelay().catch(err => {
                console.error('[ST-Saver] initial initBaselineFromRelay error:', err);
            });
        }
    }, 1500);  // 等酒馆完全加载

    // 切换聊天 → 清空当前 session，主动建立新基线
    // 让第一次保存就能直接走增量（不再"首次走全量上传"）
    if (eventSource && event_types?.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            clearSession();
            // 异步去拉基线，不阻塞酒馆界面
            // 拉不到也没事，下次保存会自动 fallback 到原版全量
            setTimeout(() => {
                initBaselineFromRelay().catch(err => {
                    console.error('[ST-Saver] initBaselineFromRelay error:', err);
                });
            }, 200);  // 等 200ms 让酒馆完成 chat 切换
        });
    }
});
