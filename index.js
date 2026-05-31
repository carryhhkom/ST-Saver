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
    relayDebugLog: false,
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

const RELAY_TIMEOUT_MS = 8000;

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
async function relayFetch(path, init = {}, timeoutMs = RELAY_TIMEOUT_MS) {
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
 * @param {*} _originalHeaders  保留参数槽位以备后续用，当前忽略
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
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function postDelta(originalHeaders, chatToSave) {
    if (!currentSession || !currentSession.inited) {
        return { ok: false, reason: 'no_session' };
    }

    const session = currentSession;
    const delta = computeDelta(session.lastSyncedHashes, chatToSave);

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
 * 用增量同步处理 saveChat。
 * 失败时返回 null，让外层走原版全量。
 */
async function handleIncrementalSave(url, init) {
    const settings = getSettings();
    if (!settings.relayEnabled) return null;

    const parsedBody = extractChatToSaveFromRequest(url, init);
    if (!parsedBody) return null;

    const chatToSave = parsedBody.chat;

    // 没有基线 → 第一次拦截到 → 用 saveChat 自带的 chat 直接建基线，并走全量保存
    // （这是最安全的初始化路径：本次保存照常走全量，下一次开始才走增量）
    if (!currentSession || !currentSession.inited) {
        const resolved = resolveCurrentIdentity();
        if (!resolved) return null;
        const sessionKey = buildSessionKey(resolved.kind, resolved.identity);
        const hashes = computeChatHashes(chatToSave);
        const fp = fingerprintHashes(hashes);
        currentSession = {
            sessionKey,
            kind: resolved.kind,
            identity: resolved.identity,
            lastSyncedHashes: hashes,
            baselineFingerprint: fp,
            inited: true,
        };
        logRelay('first save: baseline initialized in-place, fall through to full save');
        return null; // 走全量
    }

    // 健康检查（轻量缓存）
    const ok = await checkRelayHealth(false);
    if (!ok) {
        logRelay('relay unhealthy, fallback to full save');
        throttledToast(
            'warning',
            'relay_down',
            '⚠ 中转服务不可达，本次保存走全量。请检查 st-save-relay 是否在跑。',
        );
        return null;
    }

    const result = await postDelta(init?.headers, chatToSave);
    if (result.ok) {
        // 增量成功，伪造一个 200 响应让酒馆继续
        return new Response(JSON.stringify({ result: 'ok' }), {
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

    // 切换聊天 → 清空当前 session，下次保存时按需重建
    if (eventSource && event_types?.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            clearSession();
            // 不主动 init，第一次拦截到 saveChat 时再初始化 + 走全量
        });
    }
});
