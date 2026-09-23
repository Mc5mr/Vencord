/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type Result<T> = { ok: true; value: T; } | { ok: false; error: string; };
export const statuses = ["starting", "connecting", "connected", "stopping", "stopped", "error"] as const;
export type SessionStatus = typeof statuses[number];
export interface Automation { mode: "off" | "follow" | "pull"; targetId: string; }
export interface ActionPreferences {
    afk: boolean; channelIds: string[]; njm: boolean; messages: string[];
    camera: boolean; share: boolean; typing: boolean; minMinutes: number; maxMinutes: number; mediaMinutes: number;
}
export function defaultActions(): ActionPreferences {
    return { afk: false, channelIds: [], njm: false, messages: [], camera: false, share: false, typing: false, minMinutes: 10, maxMinutes: 25, mediaMinutes: 2 };
}
export function normalizeActions(value: ActionPreferences = defaultActions()): ActionPreferences {
    return { afk: value.afk, channelIds: [...new Set(value.channelIds)], njm: value.njm, messages: value.messages.map(m => m.trim()).filter(Boolean),
        camera: value.camera, share: value.share, typing: value.typing, minMinutes: value.minMinutes, maxMinutes: value.maxMinutes, mediaMinutes: value.mediaMinutes };
}
export interface ActionInfo { config: ActionPreferences; afkNextAt: number | null; njmNextAt: number | null; lastAction: string | null; errorCode: string | null; }
export interface AccountPreferences {
    label: string; guildId: string; channelId: string; selfMute: boolean; selfDeaf: boolean;
    kind?: "guild" | "dm";
    platform: "desktop" | "mobile"; automation: Automation;
    actions?: ActionPreferences;
}
export interface SavedAccountInfo extends AccountPreferences { id: string; serviceUrl: string; }
export interface SessionInfo {
    id: string;
    kind?: "guild" | "dm";
    userId: string;
    username: string;
    guildId: string;
    channelId: string;
    status: SessionStatus;
    createdAt: number;
    connectedAt: number | null;
    retryAt?: number | null;
    errorCode: string | null;
    accountId?: string | null;
    selfMute?: boolean;
    selfDeaf?: boolean;
    voicePending?: boolean;
    voiceControlError?: string | null;
    platform?: "desktop" | "mobile";
    automation?: Automation & { errorCode: string | null; };
    selfVideo?: boolean;
    selfStream?: boolean;
    mediaPending?: boolean;
    mediaError?: string | null;
    actions?: ActionInfo;
    dmCleanup?: DmCleanupInfo;
}
export interface DmCleanupInfo {
    status: "idle" | "ready" | "deleting" | "waiting" | "stopping" | "completed" | "cancelled" | "error";
    channelId: string; name: string; confirmationId: string | null; expiresAt: number | null;
    scanned: number; deleted: number; skipped: number; errorCode: string | null; retryAt: number | null;
}
export interface SessionList { version: 1; maxSessions: number; sessions: SessionInfo[]; }
export const messages: Record<string, string> = {
    BAD_INPUT: "Enter a complete account token and valid IDs for the selected server room or private call.",
    DM_ONLY: "Choose an existing DM or group DM accessible to this account.",
    GUILD_ONLY: "These controls are available in server voice rooms only.",
    DM_CONFIRM: "Review the conversation again. Deletion confirmations expire after five minutes.",
    DM_BUSY: "Stop the current deletion before choosing another conversation.",
    DM_DELETE_FAILED: "Deletion stopped after a failed request. Check the conversation and review it again to continue.",
    DM_RATE_LIMIT: "Discord requested a long pause. Wait before reviewing and starting deletion again.",
    UNAUTHORIZED: "The service key is incorrect. Check Connection settings.",
    DEVICE_REQUIRED: "حدّث البلوقن على هذا الجهاز لتفعيل مفتاحه الخاص وفصل حساباته.",
    ACCESS_REQUIRED: "Enter a valid access password for the 10, 20, or 30 account tier.",
    ACCESS_WAIT: "Too many password attempts. Wait a minute before trying again.",
    LIMIT: "Stop an active session before adding another account.",
    WAIT: "Wait a few seconds before trying again.",
    DUPLICATE: "This account already has an active session.",
    LOGIN_FAILED: "Discord did not allow the sign-in. Check the token or sign in normally.",
    AUTH_REVIEW: "Discord طلب تحققًا أو رفض تسجيل الدخول. توقفت الجلسة؛ راجع التنبيه داخل التطبيق قبل المحاولة مجددًا.",
    RATE_LIMITED: "Discord قيّد الطلبات. توقفت الجلسة ولن تعيد المحاولة تلقائيًا.",
    DISCORD_DENIED: "Discord رفض طلبًا. توقفت الجلسة؛ راجع الصلاحيات وتنبيهات حسابك.",
    ACCOUNT_PAUSED: "الحساب متوقف مؤقتًا بعد رفض من Discord. راجع حسابك وانتظر قبل إعادة المحاولة.",
    RECONNECT_STOPPED: "انقطع اتصال الحساب. توقفت الجلسة بدل إعادة تسجيل الدخول تلقائيًا.",
    USER_ONLY: "Use a user account you own. Bot tokens are not supported here.",
    CHANNEL: "The voice channel is unavailable, belongs to another server, or the account cannot connect.",
    LAVALINK_OFFLINE: "The AFK service cannot reach its configured Lavalink node.",
    LAVALINK_VERSION: "The Lavalink node needs API v4 and current Discord voice encryption support.",
    LAVALINK_VOICE: "Lavalink could not establish the voice connection.",
    VOICE_TIMEOUT: "Voice connection was not confirmed. Check channel permissions and Lavalink compatibility.",
    NOT_CONNECTED: "Wait until the account is connected before changing its voice state.",
    VOICE_CONTROL_FAILED: "Discord did not confirm the voice change. The last confirmed state is shown.",
    AUTOMATION_PERMISSION: "The account or target is missing the required voice-channel permissions.",
    AUTOMATION_FAILED: "Follow or Pull was paused after a failed operation. Check permissions before enabling it again.",
    TARGET_BUSY: "Another session is already pulling this member.",
    MEDIA_FAILED: "Discord did not confirm the media marker. No video is being transmitted.",
    ACTION_CONFLICT: "Turn off Follow / Pull before enabling AFK Action, or turn off AFK Action first.",
    ACTION_NO_ROOMS: "AFK Action needs at least two accessible voice rooms in this server.",
    ACTION_PERMISSION: "The action was paused because a required channel permission is missing.",
    ACTION_FAILED: "The action was paused after a failed request. Check the settings before enabling it again.",
    DISCONNECTED: "The voice connection ended. Start again when ready.",
    MOVED: "The account left or was moved out of the target channel. AFK was stopped.",
    SERVICE_ERROR: "The AFK service could not complete the operation.",
    NOT_FOUND: "This session is no longer available.",
    STOPPING: "The AFK service is shutting down."
};

export function isSnowflake(value: unknown): value is string { return typeof value === "string" && /^\d{17,20}$/.test(value); }
export function isToken(value: unknown): value is string {
    return typeof value === "string" && value.length >= 20 && value.length <= 2048 && /^[\w.-]+$/.test(value)
        && (value.startsWith("mfa.") || value.split(".").length === 3);
}
export function isSession(value: unknown): value is SessionInfo {
    if (!value || typeof value !== "object") return false;
    const s = value as SessionInfo;
    return typeof s.id === "string" && /^[a-f0-9-]{36}$/.test(s.id)
        && (s.userId === "" || isSnowflake(s.userId)) && typeof s.username === "string" && s.username.length <= 80
        && isDestination(s) && statuses.includes(s.status)
        && Number.isFinite(s.createdAt) && (s.connectedAt === null || Number.isFinite(s.connectedAt))
        && (s.retryAt === undefined || s.retryAt === null || Number.isFinite(s.retryAt))
        && (s.errorCode === null || typeof s.errorCode === "string" && Object.hasOwn(messages, s.errorCode))
        && (s.accountId === undefined || s.accountId === null || typeof s.accountId === "string" && /^[a-f0-9-]{36}$/.test(s.accountId))
        && (s.selfMute === undefined || typeof s.selfMute === "boolean")
        && (s.selfDeaf === undefined || typeof s.selfDeaf === "boolean")
        && (s.voicePending === undefined || typeof s.voicePending === "boolean")
        && (s.voiceControlError === undefined || s.voiceControlError === null || s.voiceControlError === "VOICE_CONTROL_FAILED")
        && (s.platform === undefined || ["desktop", "mobile"].includes(s.platform))
        && (s.automation === undefined || isAutomation(s.automation) && (s.automation.errorCode === null || ["AUTOMATION_PERMISSION", "AUTOMATION_FAILED"].includes(s.automation.errorCode)))
        && (s.selfVideo === undefined || typeof s.selfVideo === "boolean")
        && (s.selfStream === undefined || typeof s.selfStream === "boolean")
        && (s.mediaPending === undefined || typeof s.mediaPending === "boolean")
        && (s.mediaError === undefined || s.mediaError === null || s.mediaError === "MEDIA_FAILED")
        && (s.actions === undefined || s.actions !== null && isActionPreferences(s.actions.config)
            && (s.actions.afkNextAt === null || Number.isFinite(s.actions.afkNextAt))
            && (s.actions.njmNextAt === null || Number.isFinite(s.actions.njmNextAt))
            && (s.actions.lastAction === null || ["afk-move", "message", "typing", "camera", "share"].includes(s.actions.lastAction))
            && (s.actions.errorCode === null || ["ACTION_CONFLICT", "ACTION_NO_ROOMS", "ACTION_PERMISSION", "ACTION_FAILED"].includes(s.actions.errorCode)))
        && (s.dmCleanup === undefined || isDmCleanup(s.dmCleanup));
}

function isDestination(value: { kind?: string; guildId: string; channelId: string; }): boolean {
    return (value.kind === undefined || value.kind === "guild" || value.kind === "dm")
        && (value.kind === "dm" ? value.guildId === "" : isSnowflake(value.guildId)) && isSnowflake(value.channelId);
}

function isDmCleanup(value: DmCleanupInfo): boolean {
    return Boolean(value && ["idle", "ready", "deleting", "waiting", "stopping", "completed", "cancelled", "error"].includes(value.status)
        && (value.channelId === "" || isSnowflake(value.channelId)) && typeof value.name === "string" && value.name.length <= 120
        && (value.confirmationId === null || typeof value.confirmationId === "string" && /^[a-f0-9-]{36}$/.test(value.confirmationId))
        && (value.expiresAt === null || Number.isFinite(value.expiresAt)) && (value.retryAt === null || Number.isFinite(value.retryAt))
        && [value.scanned, value.deleted, value.skipped].every(n => Number.isSafeInteger(n) && n >= 0)
        && (value.errorCode === null || typeof value.errorCode === "string" && Object.hasOwn(messages, value.errorCode)));
}

export function isAutomation(value: unknown): value is Automation {
    if (!value || typeof value !== "object") return false;
    const a = value as Automation;
    return ["off", "follow", "pull"].includes(a.mode) && (a.mode === "off" ? a.targetId === "" : isSnowflake(a.targetId));
}

export function isAccountPreferences(value: unknown): value is AccountPreferences {
    if (!value || typeof value !== "object") return false;
    const p = value as AccountPreferences;
    return typeof p.label === "string" && p.label.length <= 80 && !/[\u0000-\u001f\u007f]/.test(p.label)
        && (isDestination(p) || (p.kind === undefined || ["guild", "dm"].includes(p.kind)) && p.guildId === "" && p.channelId === "") && typeof p.selfMute === "boolean"
        && typeof p.selfDeaf === "boolean" && !(p.selfDeaf && !p.selfMute)
        && ["desktop", "mobile"].includes(p.platform) && isAutomation(p.automation)
        && (p.actions === undefined || isActionPreferences(p.actions) && !(p.actions.afk && p.automation.mode !== "off"))
        && (p.kind !== "dm" || p.automation.mode === "off" && !p.actions?.afk && !p.actions?.njm);
}
export function isActionPreferences(value: unknown): value is ActionPreferences {
    if (!value || typeof value !== "object") return false;
    const a = value as ActionPreferences;
    return [a.afk, a.njm, a.camera, a.share, a.typing].every(b => typeof b === "boolean")
        && Array.isArray(a.channelIds) && a.channelIds.length <= 12 && a.channelIds.every(isSnowflake)
        && !(a.afk && new Set(a.channelIds).size === 1)
        && Array.isArray(a.messages) && a.messages.length <= 3 && a.messages.every(m => typeof m === "string" && m.length <= 200 && !/[\u0000-\u001f\u007f]/.test(m))
        && (!a.njm || a.camera || a.share || a.typing || a.messages.some(m => m.trim().length > 0))
        && Number.isInteger(a.minMinutes) && a.minMinutes >= 5 && a.minMinutes <= 120
        && Number.isInteger(a.maxMinutes) && a.maxMinutes >= a.minMinutes && a.maxMinutes <= 180
        && Number.isInteger(a.mediaMinutes) && a.mediaMinutes >= 1 && a.mediaMinutes <= 5;
}
export function isSessionList(value: unknown): value is SessionList {
    if (!value || typeof value !== "object") return false;
    const list = value as SessionList;
    return list.version === 1 && Number.isInteger(list.maxSessions) && list.maxSessions >= 1 && list.maxSessions <= 30
        && Array.isArray(list.sessions) && list.sessions.length <= 60 && list.sessions.every(isSession);
}
export function active(session: SessionInfo): boolean { return ["starting", "connecting", "connected", "stopping"].includes(session.status); }
