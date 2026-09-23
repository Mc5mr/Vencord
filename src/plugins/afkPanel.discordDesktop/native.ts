/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { randomBytes, randomUUID } from "crypto";
import { type IpcMainInvokeEvent, safeStorage } from "electron";
import { mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { join } from "path";

import { active, isAccountPreferences, isActionPreferences, isAutomation, isSession, isSessionList, isSnowflake, isToken, messages, normalizeActions, type AccountPreferences, type Result, type SavedAccountInfo, type SessionInfo, type SessionList } from "./shared";

interface Connection { url: string; key: string; accessCode?: string; }
const directory = join(DATA_DIR, "mc5mrAfkPanel");
const file = join(directory, "connection.encrypted");
const accountsFile = join(directory, "accounts.encrypted");
const devicesFile = join(directory, "devices.encrypted");
interface SavedAccount extends SavedAccountInfo { token: string; }
let accountsQueue: Promise<unknown> = Promise.resolve();
let devicesQueue: Promise<unknown> = Promise.resolve();

function deviceKeyFor(url: string): Promise<string> {
    const task = devicesQueue.then(async () => {
        let entries: { url: string; key: string; }[] = [];
        try {
            if ((await stat(devicesFile)).size > 64 * 1024) throw Error("Invalid device storage");
            const value = JSON.parse(safeStorage.decryptString(await readFile(devicesFile)));
            if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 32
                || value.entries.some((item: { url: string; key: string; }) => !item || validateUrl(item.url) !== item.url || !/^[a-f0-9]{64}$/.test(item.key))
                || new Set(value.entries.map((item: { url: string; }) => item.url)).size !== value.entries.length) throw Error("Invalid device storage");
            entries = value.entries;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        const existing = entries.find(item => item.url === url);
        if (existing) return existing.key;
        if (entries.length >= 32) throw Error("Too many saved services");
        const key = randomBytes(32).toString("hex");
        entries.push({ url, key });
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, `${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, safeStorage.encryptString(JSON.stringify({ version: 1, entries })), { flag: "wx", mode: 0o600 });
            await rename(temporary, devicesFile);
        } finally { await rm(temporary, { force: true }); }
        return key;
    });
    devicesQueue = task.then(() => undefined, () => undefined);
    return task;
}

function withAccounts<T>(action: () => Promise<T>): Promise<T> {
    const task = accountsQueue.then(action, action);
    accountsQueue = task.then(() => undefined, () => undefined);
    return task;
}

function preferences(value: AccountPreferences): AccountPreferences {
    return { label: value.label.trim(), kind: value.kind || "guild", guildId: value.guildId, channelId: value.channelId,
        selfMute: value.selfMute, selfDeaf: value.selfDeaf, platform: "desktop",
        automation: { mode: value.automation.mode, targetId: value.automation.targetId }, actions: normalizeActions(value.actions) };
}

function publicAccount(value: SavedAccount): SavedAccountInfo {
    return { ...preferences(value), id: value.id, serviceUrl: value.serviceUrl };
}

async function readAccounts(): Promise<SavedAccount[]> {
    try {
        if ((await stat(accountsFile)).size > 256 * 1024) throw Error("Invalid account storage");
        const saved = JSON.parse(safeStorage.decryptString(await readFile(accountsFile)));
        if (saved?.version !== 1 || !Array.isArray(saved.accounts) || saved.accounts.length > 30
            || saved.accounts.some((a: SavedAccount) => !isAccountPreferences(a) || !isToken(a.token)
                || typeof a.id !== "string" || !/^[a-f0-9-]{36}$/.test(a.id) || validateUrl(a.serviceUrl) !== a.serviceUrl)
            || new Set(saved.accounts.map((a: SavedAccount) => a.id)).size !== saved.accounts.length) throw Error("Invalid account storage");
        return saved.accounts;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }
}

async function writeAccounts(accounts: SavedAccount[]) {
    const encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, accounts }));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
        await rename(temporary, accountsFile);
    } finally { await rm(temporary, { force: true }); }
}

async function remember(session: SessionInfo, changes: Partial<AccountPreferences>) {
    if (!session.accountId) return;
    await withAccounts(async () => {
        const connection = await readConnection();
        const accounts = await readAccounts();
        const index = accounts.findIndex(a => a.id === session.accountId && a.serviceUrl === connection?.url);
        if (index === -1) return;
        const next = { ...accounts[index], ...changes };
        if (!isAccountPreferences(next)) return;
        accounts[index] = next;
        await writeAccounts(accounts);
    });
}

function validateUrl(value: unknown): string {
    if (typeof value !== "string" || value.length > 500) throw Error("Invalid URL");
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
        || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw Error("Invalid URL");
    return url.origin;
}

async function readConnection(): Promise<Connection | null> {
    try {
        if ((await stat(file)).size > 8192) throw Error("Invalid configuration");
        const value = JSON.parse(safeStorage.decryptString(await readFile(file))) as Connection;
        if (validateUrl(value.url) !== value.url || typeof value.key !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value.key)) throw Error("Invalid configuration");
        if (value.accessCode !== undefined && (typeof value.accessCode !== "string" || value.accessCode !== "" && !/^[A-Za-z0-9_-]{2,128}$/.test(value.accessCode))) throw Error("Invalid configuration");
        return { url: value.url, key: value.key, accessCode: value.accessCode || "" };
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

async function guarded<T>(event: IpcMainInvokeEvent, action: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
        if (event.senderFrame !== event.sender.mainFrame || !["https://discord.com", "https://canary.discord.com", "https://ptb.discord.com"].includes(new URL(event.senderFrame.url).origin)) return { ok: false, error: "Open AFK Panel from Discord desktop." };
        if (!safeStorage.isEncryptionAvailable() || process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") return { ok: false, error: "Encrypted storage is unavailable on this device." };
        return await action();
    } catch {
        return { ok: false, error: "Could not read or save the encrypted connection settings. Existing settings were preserved." };
    }
}

async function api(connection: Connection, route: string, method = "GET", body?: unknown): Promise<Result<unknown>> {
    const deviceKey = await deviceKeyFor(connection.url);
    if (method !== "GET") {
        const health = await requestApi(connection, deviceKey, "/v1/health");
        if (!health.ok) return health;
        if ((health.value as { controlsVersion?: number; })?.controlsVersion !== 5) return { ok: false, error: "حدّث الخادم لتفعيل فصل الأجهزة قبل تشغيل الحسابات." };
    }
    return requestApi(connection, deviceKey, route, method, body);
}

function requestApi(connection: Connection, deviceKey: string, route: string, method = "GET", body?: unknown): Promise<Result<unknown>> {
    return new Promise(resolve => {
        const url = new URL(connection.url + route);
        const request = url.protocol === "https:" ? httpsRequest : httpRequest;
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = request(url, { method, signal: AbortSignal.timeout(12_000), headers: {
            Authorization: `Bearer ${connection.key}`, Accept: "application/json",
            "X-AFK-Device-Key": deviceKey,
            ...(connection.accessCode ? { "X-AFK-Password": connection.accessCode } : {}),
            ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) })
        } }, response => {
            const chunks: Buffer[] = []; let size = 0;
            response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > 128 * 1024) { req.destroy(); resolve({ ok: false, error: "The service returned an unexpected response." }); }
                else chunks.push(chunk);
            });
            response.on("error", () => resolve({ ok: false, error: "The connection to the AFK service was interrupted." }));
            response.on("end", () => {
                try {
                    // Redirects are never followed, and raw response/error text is never displayed.
                    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300 && value?.ok === true) {
                        if (value.deviceIsolation !== 1) return resolve({ ok: false, error: "الخادم قديم ولا يفصل حسابات الأجهزة. حدّث خدمة AFK أولًا." });
                        return resolve({ ok: true, value: value.value });
                    }
                    const code = typeof value?.code === "string" && Object.hasOwn(messages, value.code) ? value.code : "SERVICE_ERROR";
                    resolve({ ok: false, error: messages[code] });
                } catch { resolve({ ok: false, error: "This address did not return an AFK Panel response." }); }
            });
        });
        req.on("error", () => resolve({ ok: false, error: "Could not reach the AFK service. Check its address and make sure it is running." }));
        req.end(payload);
    });
}

async function configured<T>(validate: (value: unknown) => value is T, route: string, method = "GET", body?: unknown): Promise<Result<T>> {
    const connection = await readConnection();
    if (!connection) return { ok: false, error: "Set up the service in the Connection tab first." };
    const result = await api(connection, route, method, body);
    if (!result.ok) return result;
    return validate(result.value) ? { ok: true, value: result.value } : { ok: false, error: "The AFK service returned an unsupported response. Check its version." };
}

export async function getServer(event: IpcMainInvokeEvent): Promise<Result<{ url: string; hasKey: boolean; }>> {
    return guarded(event, async () => {
        const connection = await readConnection();
        return { ok: true, value: { url: connection?.url || "http://127.0.0.1:3847", hasKey: Boolean(connection) } };
    });
}

export async function saveServer(event: IpcMainInvokeEvent, inputUrl: unknown, inputKey: unknown, inputAccessCode?: unknown): Promise<Result<{ url: string; hasKey: boolean; }>> {
    return guarded(event, async () => {
        let url: string;
        try { url = validateUrl(inputUrl); } catch { return { ok: false, error: "Use an HTTPS service address, or HTTP on localhost. Include the port when needed; use no path or query." }; }
        const old = await readConnection();
        const key = typeof inputKey === "string" && inputKey ? inputKey : old?.url === url ? old.key : "";
        if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) return { ok: false, error: "Paste the service key from afkpanel.local.json." };
        const accessCode = typeof inputAccessCode === "string" && inputAccessCode ? inputAccessCode : old?.url === url ? old.accessCode || "" : "";
        if (accessCode && !/^[A-Za-z0-9_-]{2,128}$/.test(accessCode)) return { ok: false, error: messages.ACCESS_REQUIRED };
        const test = await api({ url, key, accessCode }, "/v1/health");
        if (!test.ok) return test;
        if (!test.value || typeof test.value !== "object" || !("version" in test.value) || test.value.version !== 1) return { ok: false, error: "This is not a compatible AFK Panel service." };
        const encrypted = safeStorage.encryptString(JSON.stringify({ url, key, accessCode }));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, `${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
            await rename(temporary, file);
        } finally { await rm(temporary, { force: true }); }
        return { ok: true, value: { url, hasKey: true } };
    });
}

export async function listSessions(event: IpcMainInvokeEvent): Promise<Result<SessionList>> {
    return guarded(event, () => configured(isSessionList, "/v1/sessions"));
}

export async function stopAllSessions(event: IpcMainInvokeEvent): Promise<Result<SessionList>> {
    return guarded(event, () => configured(isSessionList, "/v1/sessions/stop-all", "POST", {}));
}

export async function startSession(event: IpcMainInvokeEvent, token: unknown, guildId: unknown, channelId: unknown): Promise<Result<SessionInfo>> {
    return guarded(event, async () => {
        if (!isToken(token) || !isSnowflake(guildId) || !isSnowflake(channelId)) return { ok: false, error: messages.BAD_INPUT };
        return configured(isSession, "/v1/sessions", "POST", { token, guildId, channelId });
    });
}

export async function stopSession(event: IpcMainInvokeEvent, id: unknown): Promise<Result<SessionInfo>> {
    return guarded(event, async () => {
        if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) return { ok: false, error: messages.NOT_FOUND };
        return configured(isSession, `/v1/sessions/${id}/stop`, "POST");
    });
}

export async function setVoiceState(event: IpcMainInvokeEvent, id: unknown, selfMute: unknown, selfDeaf: unknown): Promise<Result<SessionInfo>> {
    return guarded(event, async () => {
        if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)
            || typeof selfMute !== "boolean" || typeof selfDeaf !== "boolean" || selfDeaf && !selfMute) return { ok: false, error: messages.BAD_INPUT };
        const result = await configured(isSession, `/v1/sessions/${id}/voice`, "POST", { selfMute, selfDeaf });
        if (result.ok) await remember(result.value, { selfMute, selfDeaf });
        return result;
    });
}

export async function listSavedAccounts(event: IpcMainInvokeEvent): Promise<Result<SavedAccountInfo[]>> {
    return guarded(event, () => withAccounts(async () => ({ ok: true, value: (await readAccounts()).map(publicAccount) })));
}

export async function saveAccount(event: IpcMainInvokeEvent, inputToken: unknown, inputPreferences: unknown, inputId?: unknown): Promise<Result<SavedAccountInfo>> {
    return guarded(event, () => withAccounts(async () => {
        if (!isAccountPreferences(inputPreferences) || typeof inputToken !== "string"
            || inputToken !== "" && !isToken(inputToken)
            || inputId !== undefined && (typeof inputId !== "string" || !/^[a-f0-9-]{36}$/.test(inputId))) return { ok: false, error: messages.BAD_INPUT };
        const connection = await readConnection();
        if (!connection) return { ok: false, error: "Set up the service in Connection first." };
        const accounts = await readAccounts();
        const index = accounts.findIndex(a => a.id === inputId);
        if (inputId && index < 0) return { ok: false, error: "This saved account no longer exists." };
        if (index >= 0 && accounts[index].serviceUrl !== connection.url) return { ok: false, error: "Switch to this account's saved service before editing it." };
        const token = inputToken || (index >= 0 ? accounts[index].token : "");
        if (!isToken(token)) return { ok: false, error: messages.BAD_INPUT };
        if (accounts.some((a, i) => a.token === token && i !== index)) return { ok: false, error: "This token is already saved." };
        const health = await api(connection, "/v1/health");
        if (!health.ok) return health;
        const h = health.value as { maxSessions?: number; controlsVersion?: number; };
        if (h?.controlsVersion !== 5 || !Number.isInteger(h.maxSessions) || h.maxSessions! < 1 || h.maxSessions! > 30) return { ok: false, error: "حدّث خدمة AFK وأعد تشغيلها قبل حفظ الحسابات." };
        if (index < 0 && (accounts.length >= 30 || accounts.filter(a => a.serviceUrl === connection.url).length >= h.maxSessions!)) return { ok: false, error: "Your saved-account slots are full. Forget an account or use a higher tier." };
        const account: SavedAccount = { ...preferences(inputPreferences), id: index >= 0 ? accounts[index].id : randomUUID(),
            token, serviceUrl: connection.url };
        account.label ||= `Account ${accounts.length + 1}`;
        if (index >= 0) accounts[index] = account;
        else accounts.push(account);
        await writeAccounts(accounts);
        return { ok: true, value: publicAccount(account) };
    }));
}

export async function startSavedAccount(event: IpcMainInvokeEvent, id: unknown): Promise<Result<SessionInfo>> {
    return guarded(event, () => withAccounts(async () => {
        const account = (await readAccounts()).find(a => a.id === id);
        if (!account) return { ok: false, error: "This saved account no longer exists." };
        const connection = await readConnection();
        if (!connection || connection.url !== account.serviceUrl) return { ok: false, error: "Switch to this account's saved service before starting it." };
        if (!isSnowflake(account.channelId) || account.kind !== "dm" && !isSnowflake(account.guildId)) return { ok: false, error: "اختر الروم قبل تشغيل الحساب." };
        const result = await api(connection, "/v1/sessions", "POST", { token: account.token, accountId: account.id,
            kind: account.kind || "guild", guildId: account.guildId, channelId: account.channelId, selfMute: account.selfMute,
            selfDeaf: account.selfDeaf, platform: "desktop", automation: account.automation, actions: normalizeActions(account.actions) });
        if (!result.ok) return result;
        return isSession(result.value) ? { ok: true, value: result.value } : { ok: false, error: "The service returned an unsupported session." };
    }));
}

export async function forgetAccount(event: IpcMainInvokeEvent, id: unknown): Promise<Result<SavedAccountInfo[]>> {
    return guarded(event, () => withAccounts(async () => {
        const accounts = await readAccounts();
        const account = accounts.find(a => a.id === id);
        if (!account) return { ok: true, value: accounts.map(publicAccount) };
        const connection = await readConnection();
        if (connection?.url === account.serviceUrl) {
            const sessions = await configured(isSessionList, "/v1/sessions");
            if (!sessions.ok) return sessions;
            if (sessions.value.sessions.some(s => s.accountId === id && active(s))) return { ok: false, error: "Stop this account before forgetting it." };
        } else return { ok: false, error: "Switch to this account's saved service before forgetting it." };
        const remaining = accounts.filter(a => a.id !== id);
        await writeAccounts(remaining);
        return { ok: true, value: remaining.map(publicAccount) };
    }));
}

export async function setAutomation(event: IpcMainInvokeEvent, id: unknown, value: unknown): Promise<Result<SessionInfo>> {
    return guarded(event, async () => {
        if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || !isAutomation(value)) return { ok: false, error: messages.BAD_INPUT };
        const result = await configured(isSession, `/v1/sessions/${id}/automation`, "POST", value);
        if (result.ok) await remember(result.value, { automation: value,
            ...(result.value.actions ? { actions: normalizeActions(result.value.actions.config) } : {}) });
        return result;
    });
}

export async function setMedia(event: IpcMainInvokeEvent, id: unknown, camera: unknown, share: unknown): Promise<Result<SessionInfo>> {
    return guarded(event, async () => {
        if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || typeof camera !== "boolean" || typeof share !== "boolean") return { ok: false, error: messages.BAD_INPUT };
        return configured(isSession, `/v1/sessions/${id}/media`, "POST", { camera, share });
    });
}

export async function setActions(event: IpcMainInvokeEvent, id: unknown, value: unknown): Promise<Result<SessionInfo>> {
    return guarded(event, async () => {
        if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || !isActionPreferences(value)) return { ok: false, error: messages.BAD_INPUT };
        const actions = normalizeActions(value);
        const result = await configured(isSession, `/v1/sessions/${id}/actions`, "POST", actions);
        if (result.ok) await remember(result.value, { actions,
            ...(result.value.automation ? { automation: { mode: result.value.automation.mode, targetId: result.value.automation.targetId } } : {}) });
        return result;
    });
}

export async function removeSession(event: IpcMainInvokeEvent, id: unknown): Promise<Result<SessionInfo>> {
    return guarded(event, async () => {
        if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) return { ok: false, error: messages.NOT_FOUND };
        return configured(isSession, `/v1/sessions/${id}`, "DELETE");
    });
}

export async function controlDm(event: IpcMainInvokeEvent, id: unknown, action: unknown, value?: unknown): Promise<Result<SessionInfo>> {
    return guarded(event, async () => {
        if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)
            || typeof action !== "string" || !["preview", "start", "cancel"].includes(action)
            || action === "preview" && !isSnowflake(value)
            || action === "start" && (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))) return { ok: false, error: messages.BAD_INPUT };
        const body = action === "preview" ? { channelId: value } : action === "start" ? { confirmationId: value } : {};
        return configured(isSession, `/v1/sessions/${id}/dm/${action}`, "POST", body);
    });
}
