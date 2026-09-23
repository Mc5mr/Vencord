/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import type { PluginNative } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, closeModal, Modal, openModal, SelectedChannelStore, TextInput, useEffect, useRef, useState } from "@webpack/common";

import { active, type AccountPreferences, type ActionPreferences, defaultActions, isActionPreferences, isSnowflake, isToken, messages, normalizeActions, type Result, type SavedAccountInfo, type SessionInfo } from "./shared";

const MODAL_KEY = "mc5mr-afk-panel";
const Native = VencordNative.pluginHelpers.AFKPanel as PluginNative<typeof import("./native")>;
const empty: AccountPreferences = { label: "", kind: "guild", guildId: "", channelId: "", selfMute: true, selfDeaf: true, platform: "desktop", automation: { mode: "off", targetId: "" }, actions: defaultActions() };

function voiceRoom() {
    try {
        const channel = ChannelStore.getChannel(SelectedChannelStore.getVoiceChannelId()!);
        return channel?.type === 2 && isSnowflake(channel.guild_id)
            ? { kind: "guild" as const, guildId: channel.guild_id, channelId: channel.id }
            : channel && [1, 3].includes(channel.type) ? { kind: "dm" as const, guildId: "", channelId: channel.id } : null;
    } catch { return null; }
}

function currentDm() {
    try {
        const channel = ChannelStore.getChannel(SelectedChannelStore.getChannelId()!);
        return channel && [1, 3].includes(channel.type) ? channel.id : "";
    } catch { return ""; }
}

export function PanelIcon() {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 13v-1a8 8 0 0 1 16 0v1M4 12H3a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h3v-7H4Zm16 0h1a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-3v-7h2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M9 12h6l-6 5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>;
}

function ActionFields({ value, onChange, disabled, watching }: { value: ActionPreferences; onChange(value: ActionPreferences): void; disabled: boolean; watching: boolean; }) {
    const change = (patch: Partial<ActionPreferences>) => onChange({ ...value, ...patch });
    return <div className="vc-afkp-action-fields">
        <div className="vc-afkp-checks"><label><input type="checkbox" checked={value.afk} disabled={disabled || watching} onChange={e => change({ afk: e.currentTarget.checked })} />AFK Action · تغيير الروم كل 25 دقيقة</label></div>
        <p className="vc-afkp-hint">يتنقل بين رومات السيرفر المتاحة. أوقف الفولو أو السحب أولًا.</p>
        <label className="vc-afkp-field"><span>آيديات رومات الأكشن · اختياري، كل روم في سطر</span><textarea aria-label="AFK room IDs" rows={3} maxLength={251} disabled={disabled} value={value.channelIds.join("\n")} onChange={e => change({ channelIds: e.currentTarget.value ? e.currentTarget.value.split("\n") : [] })} placeholder="اتركها فارغة لاستخدام الرومات المتاحة" /></label>
        <p className="vc-afkp-hint">اختر من رومين إلى 12 رومًا أو اتركها فارغة. يتجاوز الرومات الممتلئة وغير المتاحة.</p>
        <div className="vc-afkp-checks"><label><input type="checkbox" checked={value.njm} disabled={disabled} onChange={e => change({ njm: e.currentTarget.checked })} />njm action · حركة عشوائية من الخيارات المحددة</label></div>
        <label className="vc-afkp-field"><span>الرسائل التي تسمح بإرسالها · حتى 3، كل رسالة في سطر</span><textarea aria-label="Allowed action messages" rows={3} maxLength={602} disabled={disabled} value={value.messages.join("\n")} onChange={e => change({ messages: e.currentTarget.value ? e.currentTarget.value.split("\n") : [] })} placeholder="اتركها فارغة لإيقاف الرسائل" /></label>
        <p className="vc-afkp-hint">حتى 200 حرف للرسالة. ترسل في شات الروم الصوتي الحالي دون منشن.</p>
        <div className="vc-afkp-checks">
            <label><input type="checkbox" checked={value.camera} disabled={disabled} onChange={e => change({ camera: e.currentTarget.checked })} />إشارة كام</label>
            <label><input type="checkbox" checked={value.share} disabled={disabled} onChange={e => change({ share: e.currentTarget.checked })} />إشارة شير</label>
            <label><input type="checkbox" checked={value.typing} disabled={disabled} onChange={e => change({ typing: e.currentTarget.checked })} />إشارة كتابة</label>
        </div>
        <p className="vc-afkp-hint">الكام والشير إشارات تجريبية فقط؛ لا تسجل أو تبث أي وسائط.</p>
        <div className="vc-afkp-ids">
            <label className="vc-afkp-field"><span>أقل فاصل بين الأكشنات · بالدقائق</span><input aria-label="Minimum action minutes" type="number" min={5} max={120} value={value.minMinutes} disabled={disabled} onChange={e => change({ minMinutes: Number(e.currentTarget.value) })} /></label>
            <label className="vc-afkp-field"><span>أكبر فاصل بين الأكشنات · بالدقائق</span><input aria-label="Maximum action minutes" type="number" min={value.minMinutes} max={180} value={value.maxMinutes} disabled={disabled} onChange={e => change({ maxMinutes: Number(e.currentTarget.value) })} /></label>
        </div>
        <label className="vc-afkp-field"><span>مدة إشارة الكام أو الشير · بالدقائق</span><input aria-label="Media action minutes" type="number" min={1} max={5} value={value.mediaMinutes} disabled={disabled} onChange={e => change({ mediaMinutes: Number(e.currentTarget.value) })} /></label>
        {!isActionPreferences(value) ? <p className="vc-afkp-error" role="status">راجع الآيديات والرسائل والفواصل. يحتاج njm رسالة واحدة أو أكشنًا محددًا على الأقل.</p> : null}
    </div>;
}

function nextTime(value: number | null) { return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "متوقف"; }

function DmControls({ session, disabled, update }: { session: SessionInfo; disabled: boolean; update(label: string, action: () => Promise<Result<SessionInfo>>): void; }) {
    const [channelId, setChannelId] = useState(session.kind === "dm" ? session.channelId : "");
    const cleanup = session.dmCleanup;
    useEffect(() => { if (cleanup?.channelId) setChannelId(cleanup.channelId); }, [cleanup?.channelId]);
    if (!cleanup) return null;
    const running = ["deleting", "waiting", "stopping"].includes(cleanup.status);
    const reviewed = cleanup.status === "ready";
    const canReview = !disabled && active(session) && session.status !== "starting" && session.status !== "stopping";
    return <section className="vc-afkp-control-section"><h3>حذف رسائلي من الخاص (Delete DM)</h3>
        <p className="vc-afkp-hint">اختر محادثة خاصة واحدة. الحذف يخص رسائل الحساب @{session.username} قبل لحظة المراجعة فقط.</p>
        <label className="vc-afkp-field"><span>آيدي المحادثة الخاصة، وليس آيدي الشخص</span><TextInput aria-label="Delete DM channel ID" value={channelId} onChange={setChannelId} maxLength={20} disabled={!canReview || running || reviewed} /></label>
        {!reviewed && !running ? <div className="vc-afkp-voice-controls">
            <Button size="small" variant="secondary" disabled={!canReview} onClick={() => setChannelId(currentDm())}>استخدام المحادثة المفتوحة</Button>
            <Button size="small" variant="secondary" disabled={!canReview || !isSnowflake(channelId)} onClick={() => update("جارٍ مراجعة المحادثة…", () => Native.controlDm(session.id, "preview", channelId))}>مراجعة المحادثة</Button>
        </div> : null}
        {reviewed ? <div className="vc-afkp-delete-confirm" role="group" aria-label="Confirm DM message deletion">
            <strong>{cleanup.name}</strong>
            <p>الحساب: @{session.username} · {session.userId}<br />المحادثة: {cleanup.channelId}</p>
            <p>يحذف رسائل هذا الحساب ومرفقاتها نهائيًا من هذه المحادثة. لا يمكن التراجع. رسائل الآخرين وإشعارات المكالمات تبقى.</p>
            <div className="vc-afkp-voice-controls">
                <Button size="small" variant="dangerSecondary" disabled={disabled || !active(session) || !cleanup.expiresAt || Date.now() >= cleanup.expiresAt} onClick={() => update("جارٍ بدء حذف الرسائل…", () => Native.controlDm(session.id, "start", cleanup.confirmationId))}>تأكيد حذف رسائلي</Button>
                <Button size="small" variant="secondary" disabled={disabled} onClick={() => update("جارٍ إلغاء المراجعة…", () => Native.controlDm(session.id, "cancel"))}>إلغاء</Button>
            </div>
        </div> : null}
        {cleanup.status !== "idle" && !reviewed ? <p role="status">{({ deleting: "جارٍ الحذف", waiting: "بانتظار حد الطلبات", stopping: "جارٍ الإيقاف", completed: "اكتمل", cancelled: "توقف", error: "توقف بسبب خطأ" } as Record<string, string>)[cleanup.status]} · فُحصت {cleanup.scanned} · حُذفت {cleanup.deleted} · تُجاوزت {cleanup.skipped}{cleanup.retryAt ? ` · الانتظار حتى ${nextTime(cleanup.retryAt)}` : ""}</p> : null}
        {running ? <><Button size="small" variant="dangerSecondary" disabled={disabled || cleanup.status === "stopping"} onClick={() => update("جارٍ إيقاف الحذف…", () => Native.controlDm(session.id, "cancel"))}>إيقاف الحذف</Button><p className="vc-afkp-hint">إغلاق اللوحة لا يوقف الحذف. زر إيقاف الحذف يلغي العمل المتبقي؛ وقد يكتمل طلب وصل إلى Discord بالفعل.</p></> : null}
        {cleanup.errorCode ? <p className="vc-afkp-error">{messages[cleanup.errorCode] || messages.DM_DELETE_FAILED}</p> : null}
    </section>;
}

function LiveControls({ session, disabled, update }: { session: SessionInfo; disabled: boolean; update(label: string, action: () => Promise<Result<SessionInfo>>): void; }) {
    const [followId, setFollowId] = useState(session.automation?.mode === "follow" ? session.automation.targetId : "");
    const [pullId, setPullId] = useState(session.automation?.mode === "pull" ? session.automation.targetId : "");
    const [actions, setActions] = useState<ActionPreferences>(session.actions?.config || defaultActions());
    useEffect(() => { if (session.automation?.mode === "follow") setFollowId(session.automation.targetId); if (session.automation?.mode === "pull") setPullId(session.automation.targetId); }, [session.automation?.mode, session.automation?.targetId]);
    useEffect(() => { setActions(session.actions?.config || defaultActions()); }, [JSON.stringify(session.actions?.config)]);
    const connected = session.status === "connected";
    return <>
        {typeof session.selfMute === "boolean" && typeof session.selfDeaf === "boolean" ? <div className="vc-afkp-voice-controls">
            <Button size="small" variant="secondary" disabled={disabled || !connected || session.voicePending} onClick={() => update("جارٍ تغيير الميوت…", () => Native.setVoiceState(session.id, !session.selfMute, session.selfMute ? false : Boolean(session.selfDeaf)))}>{session.selfMute ? "فك الميوت" : "ميوت"}</Button>
            <Button size="small" variant="secondary" disabled={disabled || !connected || session.voicePending} onClick={() => update("جارٍ تغيير الدفن…", () => Native.setVoiceState(session.id, session.selfDeaf ? Boolean(session.selfMute) : true, !session.selfDeaf))}>{session.selfDeaf ? "فك الدفن" : "دفن"}</Button>
            {session.voicePending ? <span>بانتظار تأكيد Discord…</span> : null}
        </div> : null}
        {session.kind !== "dm" && session.automation ? <>
            <section className="vc-afkp-control-section"><h3>فولو يوزر (Follow User)</h3>
                <label className="vc-afkp-field"><span>آيدي المستخدم</span><TextInput aria-label="Follow user ID" value={followId} onChange={setFollowId} maxLength={20} disabled={disabled} placeholder="آيدي الشخص الذي تريد متابعته" /></label>
                <div className="vc-afkp-voice-controls"><Button disabled={disabled || !connected || !isSnowflake(followId) || Boolean(session.actions?.config.afk)} onClick={() => update("تشغيل الفولو…", () => Native.setAutomation(session.id, { mode: "follow", targetId: followId }))}>تبع</Button><Button variant="dangerSecondary" disabled={disabled || session.automation.mode !== "follow" || !active(session)} onClick={() => update("إيقاف الفولو…", () => Native.setAutomation(session.id, { mode: "off", targetId: "" }))}>إيقاف الفولو</Button></div>
            </section>
            <section className="vc-afkp-control-section"><h3>سحب عضو (Pull User)</h3>
                <label className="vc-afkp-field"><span>آيدي العضو</span><TextInput aria-label="Pull user ID" value={pullId} onChange={setPullId} maxLength={20} disabled={disabled} placeholder="آيدي العضو الذي وافق على سحبه" /></label>
                <div className="vc-afkp-voice-controls"><Button disabled={disabled || !connected || !isSnowflake(pullId) || Boolean(session.actions?.config.afk)} onClick={() => update("تشغيل السحب…", () => Native.setAutomation(session.id, { mode: "pull", targetId: pullId }))}>سحب</Button><Button variant="dangerSecondary" disabled={disabled || session.automation.mode !== "pull" || !active(session)} onClick={() => update("إيقاف السحب…", () => Native.setAutomation(session.id, { mode: "off", targetId: "" }))}>إيقاف السحب</Button></div>
                <p className="vc-afkp-hint">داخل السيرفر نفسه. السحب يحتاج صلاحية نقل الأعضاء وموافقة الشخص. تشغيل السحب يوقف الفولو والعكس.</p>
            </section>
        </> : null}
        {session.kind !== "dm" && session.actions ? <details className="vc-afkp-details"><summary>أكشنات إضافية · AFK / njm</summary>
            <ActionFields value={actions} onChange={setActions} disabled={disabled} watching={Boolean(session.automation && session.automation.mode !== "off")} />
            <Button size="small" disabled={disabled || !isActionPreferences(actions) || (!connected && (actions.afk || actions.njm))} onClick={() => update("جارٍ حفظ الأكشنات…", () => Native.setActions(session.id, normalizeActions(actions)))}>تطبيق وحفظ الأكشنات</Button>
            <p className="vc-afkp-hint">النقلة التالية: {nextTime(session.actions.afkNextAt)} · الأكشن التالي: {nextTime(session.actions.njmNextAt)}{session.actions.lastAction ? ` · الأخير: ${session.actions.lastAction}` : ""}</p>
            <p className="vc-afkp-hint">الأكشنات تبدأ متوقفة بعد كل دخول جديد. فعّل ما تحتاجه يدويًا؛ الإيقاف يلغي المؤقتات.</p>
        </details> : null}
        {session.kind !== "dm" && typeof session.selfVideo === "boolean" ? <details className="vc-afkp-details"><summary>إشارات الكام والشير التجريبية</summary>
            <p className="vc-afkp-hint">إشارات فقط؛ لا تبث كاميرا أو شاشة، وقد يلغيها Discord. لا تضمن منع الخمول أو حماية الحساب.</p>
            <div className="vc-afkp-voice-controls">
                <Button size="small" variant="secondary" disabled={disabled || !connected || session.mediaPending} onClick={() => update("جارٍ تغيير إشارة الكام…", () => Native.setMedia(session.id, !session.selfVideo, Boolean(session.selfStream)))}>{session.selfVideo ? "إيقاف إشارة الكام" : "إشارة كام"}</Button>
                <Button size="small" variant="secondary" disabled={disabled || !connected || session.mediaPending} onClick={() => update("جارٍ تغيير إشارة الشير…", () => Native.setMedia(session.id, Boolean(session.selfVideo), !session.selfStream))}>{session.selfStream ? "إيقاف إشارة الشير" : "إشارة شير"}</Button>
                {session.mediaPending ? <span>بانتظار تأكيد Discord…</span> : null}
            </div>
        </details> : null}
        <DmControls session={session} disabled={disabled} update={update} />
        {[session.errorCode, session.voiceControlError, session.automation?.errorCode, session.mediaError, session.actions?.errorCode].filter(Boolean).map((code, index) => <p key={index} className="vc-afkp-error">{messages[code!] || messages.SERVICE_ERROR}</p>)}
    </>;
}

const SafeControls = ErrorBoundary.wrap(LiveControls, { message: "تعذر عرض أدوات الحساب. أغلق اللوحة وافتحها مجددًا." });

type Run = <T>(label: string, request: () => Promise<Result<T>>, success?: (value: T) => void) => Promise<void>;
const stateLabel: Record<string, string> = { starting: "يسجّل الدخول", connecting: "يتصل بالروم", connected: "متصل", stopping: "جارٍ الإيقاف", stopped: "متوقف", error: "توقفت الجلسة" };

function AccountWorkspace({ account, session, disabled, run }: { account: SavedAccountInfo; session?: SessionInfo; disabled: boolean; run: Run; }) {
    const [label, setLabel] = useState(account.label);
    const [guildId, setGuildId] = useState(account.kind === "dm" ? "" : account.guildId);
    const [channelId, setChannelId] = useState(account.kind === "dm" ? "" : account.channelId);
    const [dmId, setDmId] = useState(account.kind === "dm" ? account.channelId : "");
    const [mute, setMute] = useState(account.selfMute), [deaf, setDeaf] = useState(account.selfDeaf);
    const running = Boolean(session && active(session));
    const paused = Boolean(session?.retryAt && session.retryAt > Date.now());
    const update = (title: string, request: () => Promise<Result<SessionInfo>>) => { void run(title, request); };
    async function join(kind: "guild" | "dm") {
        const target = kind === "guild" ? channelId.trim() : dmId.trim();
        const prefs: AccountPreferences = { ...account, label, kind, guildId: kind === "guild" ? guildId.trim() : "", channelId: target,
            selfMute: mute, selfDeaf: deaf, platform: "desktop", automation: kind === "dm" ? { mode: "off", targetId: "" } : account.automation,
            actions: { ...normalizeActions(account.actions), afk: false, njm: false } };
        await run("حفظ الوجهة وتشغيل الحساب…", async () => {
            const saved = await Native.saveAccount("", prefs, account.id);
            if (!saved.ok) return saved;
            return Native.startSavedAccount(account.id);
        });
    }
    function chooseRoom(id: string) {
        setChannelId(id);
        try {
            const room = ChannelStore.getChannel(id);
            if (isSnowflake(room?.guild_id)) setGuildId(room.guild_id);
        } catch { /* Manual server ID remains available. */ }
    }
    return <div className="vc-afkp-workspace">
        <div className="vc-afkp-account-heading"><div><h3>{session?.username ? `@${session.username}` : account.label}</h3><span>{session ? stateLabel[session.status] : "محفوظ على هذا الجهاز"}</span></div><span className="vc-afkp-device-chip">هذا الجهاز فقط</span></div>
        {session?.errorCode ? <p className="vc-afkp-error" role="status">{messages[session.errorCode]}</p> : null}
        {paused ? <p className="vc-afkp-error">راجع حسابك داخل Discord أولًا. المحاولة متوقفة حتى {nextTime(session!.retryAt!)}.</p> : null}
        <section className="vc-afkp-control-section"><h3>دخول روم AFK</h3>
            <label className="vc-afkp-field"><span>آيدي الروم الصوتي</span><TextInput aria-label="Voice channel ID" value={channelId} onChange={chooseRoom} maxLength={20} disabled={disabled || running} placeholder="أدخل آيدي الروم الصوتي" /></label>
            <div className="vc-afkp-ids"><label className="vc-afkp-field"><span>آيدي السيرفر</span><TextInput aria-label="Server ID" value={guildId} onChange={setGuildId} maxLength={20} disabled={disabled || running} placeholder="آيدي السيرفر الموجود فيه الروم" /></label>
                <Button variant="secondary" size="small" disabled={disabled || running} onClick={() => { const room = voiceRoom(); if (room?.kind === "guild") { setChannelId(room.channelId); setGuildId(room.guildId); } else if (room?.kind === "dm") setDmId(room.channelId); }}>استخدام مكالمتي الحالية</Button></div>
            <div className="vc-afkp-voice-controls"><Button disabled={disabled || running || paused || !isSnowflake(guildId) || !isSnowflake(channelId)} onClick={() => { void join("guild"); }}>دخول روم AFK</Button>
                <Button variant="secondary" disabled={disabled || !running || session?.status === "stopping"} onClick={() => update("إيقاف الحساب…", () => Native.stopSession(session!.id))}>خروج</Button></div>
        </section>
        <section className="vc-afkp-control-section"><h3>تافيك الخاص (DM AFK)</h3>
            <label className="vc-afkp-field"><span>آيدي قناة المحادثة</span><TextInput aria-label="DM voice channel ID" value={dmId} onChange={setDmId} maxLength={20} disabled={disabled || running} placeholder="آيدي المحادثة، وليس آيدي الشخص" /></label>
            <div className="vc-afkp-voice-controls"><Button disabled={disabled || running || paused || !isSnowflake(dmId)} onClick={() => { void join("dm"); }}>دخول مكالمة الخاص</Button><Button variant="secondary" disabled={disabled || !running || session?.status === "stopping"} onClick={() => update("إيقاف الحساب…", () => Native.stopSession(session!.id))}>إيقاف</Button></div>
            <p className="vc-afkp-hint">اتصال صوتي في DM أو مجموعة خاصة موجودة. الميزة تجريبية وتعتمد على الهوست.</p>
        </section>
        {session ? <SafeControls key={session.id} session={session} disabled={disabled} update={update} /> : <p className="vc-afkp-hint">بعد دخول الحساب تظهر أدوات الفولو والسحب وحذف رسائلك في الخاص.</p>}
        <details className="vc-afkp-details"><summary>إعدادات الحساب المحفوظ</summary>
            <label className="vc-afkp-field"><span>اسم الحساب في اللوحة</span><TextInput aria-label="Account name" value={label} onChange={setLabel} maxLength={80} disabled={disabled} /></label>
            <div className="vc-afkp-checks"><label><input type="checkbox" checked={mute} disabled={disabled || running} onChange={e => { setMute(e.currentTarget.checked); if (!e.currentTarget.checked) setDeaf(false); }} />ميوت عند الدخول</label><label><input type="checkbox" checked={deaf} disabled={disabled || running} onChange={e => { setDeaf(e.currentTarget.checked); if (e.currentTarget.checked) setMute(true); }} />دفن عند الدخول</label></div>
            <div className="vc-afkp-voice-controls"><Button size="small" variant="secondary" disabled={disabled} onClick={() => { void run("حفظ الاسم والإعدادات…", () => Native.saveAccount("", { ...account, label, selfMute: mute, selfDeaf: deaf, platform: "desktop" }, account.id)); }}>حفظ الإعدادات</Button><Button size="small" variant="dangerSecondary" disabled={disabled || running} onClick={() => { void run("إزالة الحساب المحفوظ…", () => Native.forgetAccount(account.id)); }}>إزالة الحساب من الجهاز</Button></div>
            <p className="vc-afkp-hint">أوقفنا تغيير المنصة التجريبي. إضافة الحساب لا تشغله تلقائيًا.</p>
        </details>
    </div>;
}

function Panel(props: RenderModalProps) {
    const [url, setUrl] = useState("http://127.0.0.1:3847"), [savedUrl, setSavedUrl] = useState("");
    const [key, setKey] = useState(""), [password, setPassword] = useState("");
    const [hasKey, setHasKey] = useState(false), [settings, setSettings] = useState(false);
    const [online, setOnline] = useState(false), [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(""), [notice, setNotice] = useState(""), [connectionError, setConnectionError] = useState("");
    const [accounts, setAccounts] = useState<SavedAccountInfo[]>([]), [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [selected, setSelected] = useState(""), [token, setToken] = useState(""), [search, setSearch] = useState("");
    const [limit, setLimit] = useState(30);
    const alive = useRef(true), polling = useRef(false), configured = useRef(false), epoch = useRef(0), working = useRef(false);
    const ready = typeof Native?.stopAllSessions === "function" && typeof Native?.controlDm === "function";
    const blocked = Boolean(busy) || loading || !ready;
    const ownAccounts = accounts.filter(a => a.serviceUrl === savedUrl);
    const current = ownAccounts.find(a => a.id === selected) || ownAccounts[0];
    const candidates = current ? sessions.filter(s => s.accountId === current.id) : [];
    const session = candidates.find(active) || candidates.at(-1);
    const totalActive = sessions.filter(active).length;
    const visible = ownAccounts.filter(account => {
        const record = sessions.find(s => s.accountId === account.id);
        return `${account.label} ${record?.username || ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
    });
    async function refresh() {
        if (!ready || polling.current || !alive.current) return;
        polling.current = true; const version = epoch.current;
        try {
            const [saved, result] = await Promise.all([Native.listSavedAccounts(), configured.current ? Native.listSessions() : Promise.resolve(null)]);
            if (!alive.current || version !== epoch.current) return;
            if (saved.ok) setAccounts(saved.value); else setNotice(saved.error);
            if (result) {
                setOnline(result.ok);
                if (result.ok) { setSessions(result.value.sessions); setLimit(result.value.maxSessions); setConnectionError(""); }
                else setConnectionError(result.error);
            }
        } catch { if (alive.current) { setOnline(false); setConnectionError("تعذر تحديث الحالة. تأكد أن خدمة AFK تعمل."); } }
        finally { polling.current = false; }
    }
    useEffect(() => {
        alive.current = true;
        if (!ready) { setLoading(false); setConnectionError("أغلق Discord بالكامل ثم افتحه بعد تثبيت التحديث."); return () => { alive.current = false; }; }
        Native.getServer().then(async result => {
            if (!alive.current) return;
            if (!result.ok) { setConnectionError(result.error); return; }
            setUrl(result.value.url); setHasKey(result.value.hasKey); setSavedUrl(result.value.hasKey ? result.value.url : "");
            configured.current = result.value.hasKey; setSettings(!result.value.hasKey); await refresh();
        }).catch(() => { if (alive.current) setConnectionError("تعذر تحميل إعدادات الاتصال."); }).finally(() => { if (alive.current) setLoading(false); });
        const timer = setInterval(() => { if (!working.current) void refresh(); }, 4000);
        return () => { alive.current = false; clearInterval(timer); };
    }, []);
    const run: Run = async (label, request, success) => {
        if (working.current || loading || !ready) return;
        working.current = true; setBusy(label); setNotice(""); epoch.current++;
        try {
            const result = await request();
            if (!alive.current) return;
            if (result.ok) { success?.(result.value); setNotice("تم تنفيذ الطلب."); }
            else setNotice(result.error);
        } catch { if (alive.current) setNotice("تعذر تأكيد النتيجة. حدّث الحالة قبل المحاولة مجددًا."); }
        finally { if (alive.current) { await refresh(); setBusy(""); } working.current = false; }
    };
    function saveConnection() {
        void run("التحقق من الاتصال…", () => Native.saveServer(url.trim(), key.trim(), password.trim()), value => {
            setSavedUrl(value.url); setUrl(value.url); setHasKey(true); configured.current = true;
            setKey(""); setPassword(""); setToken(""); setSessions([]); setSettings(false); setSelected("");
        });
    }
    function add() {
        const entered = token.trim(); setToken("");
        void run("حفظ الحساب على هذا الجهاز…", () => Native.saveAccount(entered, { ...empty, label: `حساب ${ownAccounts.length + 1}` }), value => {
            setSelected(value.id); setAccounts(previous => [...previous, value]);
        });
    }
    return <Modal {...props} size="xl" title={<span className="vc-afkp-title"><PanelIcon /> TokenAFK</span>} subtitle="الحسابات والتحكم · Mc5mr">
        <div className="vc-afkp-shell" dir="rtl">
            <div className="vc-afkp-topbar"><span className={online ? "vc-afkp-online" : ""}>{loading ? "جارٍ التحقق…" : online ? "الخدمة متصلة" : "الخدمة غير متصلة"} · {totalActive}/{limit} حساب نشط</span><div><Button size="small" variant="secondary" disabled={blocked} onClick={() => setSettings(!settings)}>{settings ? "إغلاق الإعدادات" : "إعدادات الاتصال"}</Button><Button size="small" variant="dangerSecondary" disabled={blocked || !online || totalActive === 0} onClick={() => { void run("إيقاف حسابات هذا الجهاز…", () => Native.stopAllSessions()); }}>إيقاف الكل</Button></div></div>
            {settings ? <section className="vc-afkp-settings">
                <h3>إعدادات الاتصال</h3>
                <label className="vc-afkp-field"><span>باسورد المساحة · 10 / 20 / 30 حسابًا</span><TextInput aria-label="Access password" value={password} onChange={setPassword} type="password" maxLength={128} autoComplete="new-password" disabled={blocked} placeholder={hasKey ? "اتركه فارغًا للاحتفاظ بالمحفوظ" : "باسورد مساحة الحسابات"} /></label>
                <details className="vc-afkp-details" open={!hasKey || undefined}><summary>عنوان الخادم ومفتاح الخدمة</summary><label className="vc-afkp-field"><span>عنوان الخدمة</span><TextInput aria-label="Service address" value={url} onChange={setUrl} disabled={blocked} /></label><label className="vc-afkp-field"><span>مفتاح الخدمة</span><TextInput aria-label="Service key" value={key} onChange={setKey} type="password" maxLength={128} autoComplete="new-password" disabled={blocked} placeholder={hasKey ? "محفوظ — اتركه فارغًا" : "مفتاح خدمة AFK"} /></label></details>
                <Button disabled={blocked} onClick={saveConnection}>فحص وحفظ الاتصال</Button><p className="vc-afkp-hint">ينشئ الجهاز مفتاحًا خاصًا مشفرًا تلقائيًا. مشاركة البلوقن لا تشارك حساباتك.</p>
            </section> : null}
            <section className="vc-afkp-main-card">
                <h2>Token AFK</h2><p className="vc-afkp-hint">أضف حسابًا تملكه، ثم اختره من البطاقات للتحكم فيه.</p>
                <div className="vc-afkp-add-row"><TextInput aria-label="Your account token" value={token} onChange={setToken} type="password" maxLength={2048} autoComplete="new-password" disabled={blocked} placeholder="أدخل التوكن" /><Button disabled={blocked || !online || !isToken(token.trim()) || ownAccounts.length >= limit || accounts.length >= 30} onClick={add}>إضافة</Button></div>
                <p className="vc-afkp-hint">إضافة = حفظ فقط. الدخول إلى Discord يبدأ عندما تضغط دخول الروم.</p>
                <div className="vc-afkp-list-heading"><h3>قائمة الحسابات <small>{ownAccounts.length}/{limit}</small></h3><TextInput aria-label="Search saved accounts" value={search} onChange={setSearch} maxLength={80} placeholder="بحث عن حساب" /></div>
                <div className="vc-afkp-account-strip" aria-label="Saved accounts">{visible.map(account => {
                    const records = sessions.filter(s => s.accountId === account.id), record = records.find(active) || records.at(-1);
                    const name = record?.username || account.label;
                    return <button type="button" key={account.id} aria-label={`اختيار ${account.label}`} aria-pressed={current?.id === account.id} disabled={blocked} className={`vc-afkp-account-tile ${current?.id === account.id ? "vc-afkp-account-selected" : ""}`} onClick={() => setSelected(account.id)}><span className="vc-afkp-avatar">{name.slice(0, 2).toUpperCase()}</span><strong title={name}>{name}</strong><span>{online && record ? stateLabel[record.status] : record ? "آخر حالة معروفة" : "محفوظ"}</span></button>;
                })}</div>
                {!visible.length ? <p className="vc-afkp-empty">{ownAccounts.length ? "لا يوجد حساب مطابق للبحث." : "أضف أول حساب من الخانة بالأعلى."}</p> : null}
                {current ? <AccountWorkspace key={current.id} account={current} session={session} disabled={blocked || !online} run={run} /> : null}
            </section>
            <p className="vc-afkp-hint">التوكنات محفوظة مشفرة على جهازك. التحكم في الحسابات العادية آليًا قد يؤدي إلى تقييدها؛ لا يوجد ضمان ضد تنبيهات Discord أو الحظر.</p>
            <div className="vc-afkp-footer"><Button variant="secondary" size="small" disabled={blocked} onClick={() => { void refresh(); }}>تحديث الحالة</Button><span>إغلاق اللوحة لا يوقف الجلسات أو حذف الرسائل الجاري.</span></div>
            {connectionError ? <p className="vc-afkp-error" role="status">{connectionError}</p> : null}
            {busy || notice ? <p className="vc-afkp-notice" role="status">{busy || notice}</p> : null}
        </div>
    </Modal>;
}

const SafePanel = ErrorBoundary.wrap(Panel, { message: "تعذر عرض اللوحة. أغلقها وافتحها مجددًا؛ حساباتك المحفوظة باقية." });
export function openPanel() { openModal(props => <SafePanel {...props} />, { modalKey: MODAL_KEY }); }
export function closePanel() { closeModal(MODAL_KEY); }
