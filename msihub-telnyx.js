/* =====================================================================
   MSIHub — data layer, part 3: Telnyx
   Real texting (send, receive, delivery status, pictures) and a browser
   phone (outbound + inbound calls), both through the "telnyx" edge function.
   Everything here stays dormant until an admin switches texting / calling on
   in Settings → Call & Text Settings; until then the CRM keeps logging only.
   Requires msihub-data.js + msihub-data-2.js (loaded first),
   supabase/schema-v4.sql and supabase/functions/telnyx.
   ===================================================================== */
(function () {
  'use strict';
  const M = window.MSIHub; if (!M || !M._h) return;
  const H = M._h;
  const $ = (id) => document.getElementById(id);
  const esc = H.esc;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@telnyx/webrtc@2.27.10/lib/bundle.js';
  const SDK_SRI = 'sha256-B5EVRWh+vMW8YuktbsDF3SzmoZRnZysnrgE4lrMam/c=';
  const BULK_MAX = 500;   // people per bulk text

  const P = { client: null, state: 'off', call: null, callerId: null, error: null, starting: false, retryAt: 0, retries: 0, tick: null, noPresence: false };
  const T = M.telnyx = { phone: P, status: null, statusError: null, checking: false, sending: 0 };

  const cfg = () => { const r = M.data.agency_settings.find((x) => x.key === 'telnyx'); return (r && r.value) || {}; };
  const smsOn = () => !!cfg().sms_enabled;
  const voiceOn = () => !!cfg().voice_enabled;

  function national(p) { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; }
  function e164(p) { const n = national(p); return n.length === 10 ? '+1' + n : null; }
  function findLead(name, phone) { const f = phone ? H.fmtPhone(phone) : ''; return LEADS.find((l) => (f && l.phone === f) || (name && l.name === name)) || null; }
  function findCustomer(name, phone) { const f = phone ? H.fmtPhone(phone) : ''; return CUSTOMERS.find((c) => (f && c.phone === f) || (name && (c.first + ' ' + c.last) === name)) || null; }

  // Call the edge function; errors come back as plain sentences.
  async function call(action, body) {
    const { data, error } = await M.sb.functions.invoke('telnyx', { body: Object.assign({ action }, body || {}) });
    if (error) {
      let j = null; try { j = await error.context.json(); } catch (e) { /* no JSON body */ }
      let msg = (j && (j.error || j.message)) || error.message || String(error);
      if ((error.context && error.context.status === 404) || (j && j.code === 'NOT_FOUND') || /failed to send a request/i.test(error.message || '')) msg = 'Could not reach the phone service (the "telnyx" server function may not be deployed yet).';
      throw new Error(msg);
    }
    if (data && data.error) throw new Error(data.error);
    return data || {};
  }

  // ------------------------------------------------------------------
  // TEXTING
  // ------------------------------------------------------------------
  async function uploadMedia(files) {
    const total = files.reduce((t, f) => t + (f.size || 0), 0);
    if (total > 1000000) throw new Error('Attachments are too large for a picture message (1 MB in total).');
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const path = 'mms/' + H.myId() + '/' + Date.now() + '_' + i + '_' + f.name.replace(/[^A-Za-z0-9._-]/g, '_');
      const { error } = await M.sb.storage.from('files').upload(path, f, { contentType: f.type || undefined });
      if (error) throw new Error('Could not upload ' + f.name + ': ' + error.message);
      out.push({ path, name: f.name });
    }
    return out;
  }

  // Send one real text. Never throws: resolves { ok, row } or { ok:false, error }.
  async function sendText(o) {
    const phone = H.fmtPhone(o.phone);
    if (!e164(phone)) { const error = phone ? 'That phone number does not look valid' : 'No phone number on file'; if (!o.quiet) M.toast(error, 'warn'); return { ok: false, error }; }
    const lead = o.lead || findLead(o.name, phone);
    const cust = o.customer || (lead ? null : findCustomer(o.name, phone));
    const name = o.name || (lead && lead.name) || (cust && cust.first + ' ' + cust.last) || phone;
    try {
      const media = o.files && o.files.length ? await uploadMedia(o.files) : [];
      const res = await call('sms', { to: phone, text: o.text || '', lead_id: lead ? lead.id : null, customer_id: cust ? cust.id : null, contact_name: name, media });
      if (res.row && !M.data.messages.find((m) => m.id === res.row.id)) M.data.messages.push(res.row);
      if (res.warning) M.toast(res.warning, 'warn');
      if (!o.noRemap) await M.reload([]);   // re-map from memory so threads, counts and timelines include it
      return { ok: true, row: res.row };
    } catch (e) {
      if (!o.quiet) M.toast('Text to ' + name + ' was not sent: ' + e.message, 'error');
      return { ok: false, error: e.message };
    }
  }
  T.sendText = sendText;

  // Every outbound text in the CRM funnels through M.recordText; inbound/manual logging keeps the old path.
  const _recordText = M.recordText;
  M.recordText = function (o) {
    if (!smsOn() || !o || (o.direction && o.direction !== 'outbound')) return _recordText.apply(this, arguments);
    return sendText(o);
  };

  const _sendTextReply = window.sendTextReply;
  window.sendTextReply = async function () {
    if (!smsOn()) return _sendTextReply.apply(this, arguments);
    const input = $('textThreadInput'); const text = (input && input.value.trim()) || '';
    const atts = (window.THREAD_ATTACHMENTS || []).slice();
    if (!text && !atts.length) return;
    const c = window.CURRENT_THREAD_CONTACT; if (!c || !c.phone) { M.toast('No contact selected', 'warn'); return; }
    const thread = $('textThread'); let stamp = null;
    if (thread) {
      const w = document.createElement('div'); w.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px';
      w.innerHTML = atts.map((f) => '<div class="text-bubble us" style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.20);border:1px solid rgba(255,255,255,0.30)"><span style="font-size:18px">' + fileIcon(f.name) + '</span><span>' + esc(f.name) + '</span></div>').join('') +
        (text ? '<div class="text-bubble us">' + esc(text) + '</div>' : '') + '<div class="text-bubble-time us">Sending…</div>';
      thread.appendChild(w); thread.scrollTop = thread.scrollHeight; stamp = w.lastChild;
    }
    if (input) { input.value = ''; input.focus(); }
    window.THREAD_ATTACHMENTS = []; if (typeof renderThreadAttachments === 'function') renderThreadAttachments();
    T.sending++;
    const r = await sendText({ phone: c.phone, name: c.name, text, files: atts, quiet: true });
    T.sending--;
    if (r.ok) { refreshOpenThread(); return; }
    if (stamp) { stamp.textContent = '⚠ Not sent — ' + r.error; stamp.style.color = 'var(--red)'; }
    M.toast('Text was not sent: ' + r.error, 'error');
  };

  const _inboxSendText = window.inboxSendText;
  window.inboxSendText = async function (phone) {
    if (!smsOn()) return _inboxSendText.apply(this, arguments);
    const id = 'inboxTextInput_' + String(phone || '').replace(/[^0-9]/g, '');
    const inp = $(id); const v = inp ? inp.value.trim() : '';
    if (!v || !phone) return;
    inp.value = ''; inp.disabled = true;
    const t = (window.TEXT_THREADS || {})[phone];
    const r = await sendText({ phone, name: t && t.contact !== phone ? t.contact : '', text: v });
    if (window.CURRENT_PAGE === 'inbox' && typeof refreshInbox === 'function') refreshInbox();
    if (!r.ok) { const again = $(id); if (again) again.value = v; }   // give the words back so they can retry
  };

  const _sendBulkText = window.sendBulkText;
  window.sendBulkText = async function () {
    if (!smsOn()) return _sendBulkText.apply(this, arguments);
    const ta = $('bulkTextMessage'); const msg = (ta ? ta.value : '').trim();
    if (!msg) { M.toast('Type a message before sending.', 'warn'); return; }
    const schTog = $('bulkScheduleToggle');
    if (schTog && schTog.checked) { M.toast('Scheduled sending is not available yet — untick Schedule to send now.', 'warn'); return; }
    const skipDnc = $('bulkSkipDNC'); const skip = !skipDnc || skipDnc.checked;
    const targets = []; const seen = new Set();
    const add = (t) => { const k = national(t.phone); if (k.length === 10 && !seen.has(k)) { seen.add(k); targets.push(t); } };
    [...(window.LEADS_SELECTED || [])].forEach((p) => { const l = LEADS.find((x) => x.phone === p); if (l && !(skip && l.doNotCall)) add({ phone: l.phone, name: l.name, lead: l, policy: l.policy }); });
    [...(window.CUSTOMERS_SELECTED || [])].forEach((cid) => { const c = CUSTOMERS.find((x) => x.id === cid); if (c) add({ phone: c.phone, name: c.first + ' ' + c.last, customer: c, policy: (c.policies[0] || {}).line || 'Auto' }); });
    if (!targets.length) { M.toast('Nobody selected has a valid phone number.', 'warn'); return; }
    if (targets.length > BULK_MAX) { M.toast('Bulk texts are limited to ' + BULK_MAX + ' people at a time — select fewer.', 'warn'); return; }
    if (!confirm('Send this text to ' + targets.length + (targets.length === 1 ? ' person' : ' people') + ' now? Real text messages will go out.')) return;
    closeBulkText();
    M.toast('Sending ' + targets.length + ' text' + (targets.length === 1 ? '' : 's') + '…');
    const agentFirst = (H.me().full_name || '').split(' ')[0];
    let sent = 0; const failed = [];
    for (const t of targets) {
      const text = msg.replace(/\{\{name\}\}/g, t.name.split(' ')[0]).replace(/\{\{phone\}\}/g, t.phone).replace(/\{\{agent\}\}/g, agentFirst).replace(/\{\{policy\}\}/g, t.policy || 'Auto');
      const r = await sendText({ phone: t.phone, name: t.name, text, lead: t.lead, customer: t.customer, quiet: true, noRemap: true });
      if (r.ok) sent++; else failed.push(t.name + ' (' + r.error + ')');
      await sleep(300);
    }
    await M.reload([]);
    if (failed.length) { console.warn('[MSIHub] bulk text failures', failed); M.toast('Sent ' + sent + ' of ' + targets.length + '. Not sent: ' + failed.slice(0, 3).join('; ') + (failed.length > 3 ? ' and ' + (failed.length - 3) + ' more' : ''), 'error'); }
    else M.toast('Sent ' + sent + ' text' + (sent === 1 ? '' : 's') + '.');
    if (typeof clearSelection === 'function') clearSelection();
    if (typeof clearCustomerSelection === 'function') clearCustomerSelection();
    M.refreshCurrentPage();
  };

  // Delivery status under our own bubbles, and a one-time alert when a text we sent bounces.
  const STATUS_LABEL = { delivered: 'Delivered', failed: '⚠ Not delivered', queued: 'Sending…' };
  const warned = new Set(); let firstPass = true;
  function annotate() {
    const conv = window.CONVERSATIONS || {};
    M.data.messages.forEach((m) => {
      if (m.direction !== 'outbound' || !m.provider_sid || !STATUS_LABEL[m.status]) return;
      const age = Date.now() - new Date(m.created_at).getTime();
      if (m.status === 'queued' && age > 300000) return;
      const days = conv[H.fmtPhone(m.phone)]; const day = days && days.find((d) => d.date === H.fmtDay(m.created_at));
      const time = H.fmtTime(m.created_at);
      const msg = day && day.msgs.find((x) => x.from === 'us' && !x._st && x.text === m.body && x.time === time);
      if (msg) { msg._st = m.status; msg.author = (msg.author ? esc(msg.author) + ' · ' : '') + STATUS_LABEL[m.status]; }
      if (m.status === 'failed' && !warned.has(m.id)) {
        warned.add(m.id);
        if (!firstPass && m.agent_id === H.myId() && age < 900000) M.toast('Text to ' + (m.contact_name || H.fmtPhone(m.phone)) + ' was not delivered' + (m.error ? ': ' + m.error : '.'), 'error');
      }
    });
    firstPass = false;
  }

  // Keep an open conversation window current when a reply or a status change arrives.
  function refreshOpenThread() {
    const o = $('textThreadOverlay'), c = window.CURRENT_THREAD_CONTACT;
    if (!smsOn() || T.sending || !o || o.style.display === 'none' || !c || !c.phone || typeof loadConversation !== 'function') return;
    const t = $('textThread'); const atBottom = !t || t.scrollHeight - t.scrollTop - t.clientHeight < 80;
    loadConversation(c.name, c.phone);
    if (t && atBottom) t.scrollTop = t.scrollHeight;
  }

  // Inbound text pop-ups. The base realtime handler pops one for every agent's texts and passes the
  // body straight into HTML; with real texting on we show them ourselves — only for this agent's
  // conversations (or unassigned ones), and always escaped.
  const _showTextPopup = window.showTextPopup; let direct = false;
  window.showTextPopup = function (contact, phone, preview) {
    if (smsOn() && !direct) return;
    return _showTextPopup(esc(contact), esc(phone), esc(preview));
  };
  function subscribe() {
    try {
      M.sb.channel('msihub-telnyx').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new; if (!smsOn() || !m || m.direction !== 'inbound') return;
        if (m.agent_id && m.agent_id !== H.myId()) return;   // another agent's conversation
        const phone = H.fmtPhone(m.phone);
        direct = true; try { window.showTextPopup(m.contact_name || phone, phone, m.body); } finally { direct = false; }
        if (!window.UNREAD_THREADS) window.UNREAD_THREADS = new Set();
        window.UNREAD_THREADS.add(phone);
        const badge = $('inboxBadge'); if (badge) badge.textContent = window.UNREAD_THREADS.size;
      }).subscribe();
    } catch (e) { console.warn('[MSIHub] telnyx realtime unavailable', e); }
  }

  // ------------------------------------------------------------------
  // BROWSER PHONE
  // ------------------------------------------------------------------
  let sdkPromise = null;
  function loadSdk() {
    if (window.TelnyxWebRTC && window.TelnyxWebRTC.TelnyxRTC) return Promise.resolve();
    if (!sdkPromise) sdkPromise = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = SDK_URL; s.integrity = SDK_SRI; s.crossOrigin = 'anonymous';
      s.onload = () => res(); s.onerror = () => { sdkPromise = null; rej(new Error('Could not load the phone library — check your internet connection')); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  function setState(state, error) { P.state = state; P.error = error || null; renderPhone(); }
  function retryLater() { P.retries++; P.retryAt = Date.now() + Math.min(300000, 5000 * Math.pow(2, P.retries - 1)); }

  async function startPhone() {
    if (!voiceOn() || P.client || P.starting) return;
    P.starting = true; setState('connecting');
    try {
      await loadSdk();
      const t = await call('token');
      P.callerId = t.caller_id || null;
      if (t.fresh) await sleep(5000);   // a brand-new phone login needs a few seconds before it can register
      const client = new window.TelnyxWebRTC.TelnyxRTC({ login_token: t.token });
      client.remoteElement = 'msihubPhoneAudio';
      client.on('telnyx.ready', () => { P.retries = 0; setState('ready'); beat(); });
      client.on('telnyx.error', (e) => { console.warn('[MSIHub] phone error', e); if (!P.call) dropPhone('Phone connection failed'); });
      client.on('telnyx.socket.close', () => { if (P.client === client && !P.call) dropPhone('Phone connection lost'); });
      client.on('telnyx.notification', onNotification);
      P.client = client;
      client.connect();
    } catch (e) { console.warn('[MSIHub] phone start', e); retryLater(); setState('error', e.message); }
    finally { P.starting = false; }
  }
  function teardown() {
    const c = P.client; P.client = null; if (!c) return;
    ['telnyx.ready', 'telnyx.error', 'telnyx.socket.close', 'telnyx.notification'].forEach((ev) => { try { c.off(ev); } catch (e) { /* ignore */ } });
    try { c.disconnect(); } catch (e) { /* ignore */ }
  }
  function dropPhone(why) { teardown(); retryLater(); setState('error', why); beat(); }
  // Runs after every data load: start, stop or retry the phone to match Settings.
  function syncPhone(now) {
    if (now) { P.retries = 0; P.retryAt = 0; }
    if (!voiceOn()) { if (P.client) teardown(); if (P.state !== 'off') setState('off'); return; }
    if (!P.client && !P.starting && Date.now() >= P.retryAt) startPhone();
  }
  T.reconnect = function () { if (P.state === 'ready' || P.call) return; teardown(); syncPhone(true); };

  // Tell the server this browser can take calls (inbound calls only ring agents seen in the last 90 seconds).
  async function beat() {
    if (!voiceOn() || P.noPresence || !M.sb || !M.user) return;
    const live = (window.AGENT_LIVE || []).find((a) => a.name === H.me().full_name);
    const status = P.call ? 'on-call' : P.state !== 'ready' ? 'offline' : (live && (live.status === 'dnd' || live.status === 'offline')) ? live.status : 'available';
    const { error } = await M.sb.from('phone_presence').upsert({ agent_id: H.myId(), status });
    if (error) { if (/does not exist|schema cache|not found/i.test(error.message || '')) P.noPresence = true; console.warn('[MSIHub] phone presence', error.message); }
  }
  { const o = window.setMyLiveStatus; if (typeof o === 'function') window.setMyLiveStatus = function () { const r = o.apply(this, arguments); beat(); return r; }; }

  // Live View > "On live calls" (when that page is loaded)
  function hudStart(c) { try { if (typeof hudStartCall === 'function') hudStartCall(c.name, c.phone, c.dir); } catch (e) { /* ignore */ } }
  function hudEnd() { try { if (typeof hudMe === 'function' && typeof hudWrapUp === 'function') { const me = hudMe(); if (me && me.status === 'on-call') { hudWrapUp(me.name); if (typeof hudRefresh === 'function') hudRefresh(); } } } catch (e) { /* ignore */ } }
  { const o = window.hudEndCall; window.hudEndCall = function () { if (P.call) return T.hangup(); if (typeof o === 'function') return o.apply(this, arguments); }; }

  // ---- Call log (outbound calls are logged here; inbound calls are logged by the server) ----
  async function logStart(c) {
    const base = { agent_id: H.myId(), lead_id: c.lead ? c.lead.id : null, customer_id: c.cust ? c.cust.id : null, contact_name: c.name, phone: c.phone, direction: 'outbound', missed: false, duration_sec: 0 };
    try { c.row = await H.insert('call_log', Object.assign({ status: 'dialing', from_number: P.callerId, to_number: c.to }, base)); }
    catch (e) { try { c.row = await H.insert('call_log', base); c.basic = true; } catch (e2) { H.fail('Logging call', e2); return; } }   // schema-v4 not run yet
    M.data.calls.unshift(c.row); M.reload([]);
  }
  async function logEnd(c, secs) {
    await c.logged; if (!c.row) return;
    const ids = (c.sdk && c.sdk.telnyxIDs) || {};
    const patch = c.basic ? { duration_sec: secs } : { duration_sec: secs, status: c.answeredAt ? 'completed' : 'no-answer', answered_at: c.answeredAt ? new Date(c.answeredAt).toISOString() : null, ended_at: new Date().toISOString(), provider_call_id: ids.telnyxSessionId || null };
    try { const saved = await H.update('call_log', c.row.id, patch); const i = M.data.calls.findIndex((x) => x.id === saved.id); if (i >= 0) M.data.calls[i] = saved; M.reload([]); }
    catch (e) { H.fail('Saving call', e); }
  }

  // ---- Ring tone for incoming calls ----
  let ringTimer = null, audioCtx = null;
  function beep() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = 520; g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.4); } catch (e) { /* no audio yet */ } }
  function startRing() { stopRing(); beep(); ringTimer = setInterval(beep, 1300); }
  function stopRing() { if (ringTimer) clearInterval(ringTimer); ringTimer = null; }

  const fmtSecs = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  function statusText(c) {
    if (c.dir === 'inbound' && !c.accepted) return 'Incoming call';
    if (!c.answeredAt) return c.label || 'Dialing…';
    return (c.held ? 'On hold · ' : '') + fmtSecs(Math.floor((Date.now() - c.answeredAt) / 1000));
  }

  function onNotification(n) {
    if (!n) return;
    if (n.type === 'userMediaError') { M.toast('Microphone is blocked — allow microphone access for this site, then try again.', 'error'); if (P.call && !P.call.answeredAt) finishCall(); return; }
    if (n.type !== 'callUpdate' || !n.call) return;
    const sdk = n.call; let c = P.call;
    if (c && !c.sdk && sdk.direction === 'outbound') c.sdk = sdk;
    if (!c || c.sdk !== sdk) {
      if (sdk.direction === 'inbound' && sdk.state === 'ringing') { if (c) { try { sdk.hangup(); } catch (e) { /* ignore */ } } else beginInbound(sdk); }   // busy → the server tries the next agent
      return;
    }
    switch (sdk.state) {
      case 'new': case 'requesting': case 'trying': c.label = 'Dialing…'; break;
      case 'early': case 'ringing': if (c.dir === 'outbound') c.label = 'Ringing…'; break;
      case 'answering': c.label = 'Connecting…'; break;
      case 'active':
        stopRing(); c.held = false;
        if (!c.answeredAt) { c.answeredAt = Date.now(); if (c.dir === 'inbound') hudStart(c); beat(); }
        break;
      case 'held': c.held = true; break;
      case 'hangup': case 'destroy': finishCall(sdk); return;
    }
    renderPhone();
  }

  function beginInbound(sdk) {
    const o = sdk.options || {};
    const phone = H.fmtPhone(o.remoteCallerNumber || '');
    const lead = phone ? findLead('', phone) : null; const cust = lead || !phone ? null : findCustomer('', phone);
    const c = P.call = { dir: 'inbound', sdk, phone, lead, cust, name: (lead && lead.name) || (cust && cust.first + ' ' + cust.last) || 'Unknown caller', accepted: false, answeredAt: null };
    startRing(); renderPhone();
    // Not in the working set? Look the number up among older leads.
    if (!lead && !cust && e164(phone)) {
      Promise.resolve(M.sb.from('leads').select('id').eq('phone', phone).order('received_at', { ascending: false }).limit(1))
        .then(({ data }) => (data && data[0] ? M.fetchLead(data[0].id) : null))
        .then((l) => { if (l && P.call === c) { c.lead = l; c.name = l.name; renderPhone(); } })
        .catch(() => { /* stays "Unknown caller" */ });
    }
  }

  function dial(name, phone, lead, cust) {
    if (P.call) { M.toast('Finish your current call first', 'warn'); return; }
    if (P.state !== 'ready') {
      M.toast(P.state === 'connecting' ? 'The phone is still connecting — try again in a moment.' : 'The phone is not connected' + (P.error ? ': ' + P.error : '.'), 'warn');
      if (P.state !== 'connecting') T.reconnect();
      return;
    }
    const to = e164(phone);
    if (!to) { M.toast('That phone number does not look valid', 'warn'); return; }
    if (!P.callerId) { M.toast('No caller ID number is set — an admin can pick one in Settings → Call & Text Settings.', 'warn'); return; }
    const c = P.call = { dir: 'outbound', sdk: null, to, phone: H.fmtPhone(phone), lead, cust, name: name || H.fmtPhone(phone), label: 'Dialing…', accepted: true, answeredAt: null };
    renderPhone(); hudStart(c); beat();
    c.logged = logStart(c);
    try { const sdk = P.client.newCall({ destinationNumber: to, callerNumber: P.callerId, callerName: cfg().caller_name || 'MaxSave Insurance', audio: true, video: false }); if (!c.sdk) c.sdk = sdk; }
    catch (e) { H.fail('Starting call', e); finishCall(); }
  }

  function finishCall(sdk) {
    const c = P.call; if (!c || (sdk && c.sdk && c.sdk !== sdk)) return;
    P.call = null; stopRing();
    const secs = c.answeredAt ? Math.max(0, Math.round((Date.now() - c.answeredAt) / 1000)) : 0;
    if (c.dir === 'outbound') logEnd(c, secs);
    hudEnd(); renderPhone(); beat();
    const cause = String((c.sdk && c.sdk.cause) || '').replace(/_/g, ' ').toLowerCase();
    if (c.answeredAt) M.toast('Call ended · ' + fmtSecs(secs));
    else if (c.dir === 'outbound') M.toast('Call did not connect' + (cause && cause !== 'normal clearing' ? ' (' + cause + ')' : ''), 'warn');
  }

  T.answer = function () { const c = P.call; if (!c || c.dir !== 'inbound' || c.accepted) return; c.accepted = true; c.label = 'Connecting…'; stopRing(); try { c.sdk.answer(); } catch (e) { H.fail('Answering', e); finishCall(); return; } renderPhone(); };
  T.hangup = function () {
    const c = P.call; if (!c) return;
    try { if (c.sdk) c.sdk.hangup(); } catch (e) { /* ignore */ }
    setTimeout(() => { if (P.call === c) finishCall(); }, c.sdk ? 3000 : 0);   // in case the library never reports back
  };
  T.mute = function () { const c = P.call; if (!c || !c.sdk) return; try { c.sdk.toggleAudioMute(); c.muted = !c.muted; } catch (e) { /* ignore */ } renderPhone(); };
  T.hold = function () { const c = P.call; if (!c || !c.sdk || !c.answeredAt) return; try { c.sdk.toggleHold(); c.held = !c.held; } catch (e) { /* ignore */ } renderPhone(); };
  T.keypad = function () { const c = P.call; if (!c) return; c.pad = !c.pad; renderPhone(); };
  T.key = function (d) { const c = P.call; if (!c || !c.sdk) return; try { c.sdk.dtmf(String(d)); } catch (e) { /* ignore */ } };
  T.openProfile = function () { const c = P.call; if (!c) return; if (c.lead && typeof openLeadDetail === 'function') openLeadDetail(c.lead.id); else if (c.cust && typeof openCustomerDetail === 'function') openCustomerDetail(c.cust.id); };
  T.dial = dial;

  // Every "call" button in the CRM lands here.
  const _doCall = window.doCall;
  window.doCall = function (leadName, phone, leadObj) {
    if (!voiceOn()) return _doCall.apply(this, arguments);
    if (!phone && national(leadName).length === 10 && !/[a-z]/i.test(leadName)) { phone = leadName; leadName = ''; }   // inbox threads with no name pass the number
    const lead = leadObj || findLead(leadName || (phone ? '' : window._currentLeadName), phone);
    const cust = lead ? null : findCustomer(leadName, phone);
    const p = phone || (lead && lead.phone) || (cust && cust.phone) || '';
    if (lead && lead.doNotCall) { M.toast('This lead is marked DO NOT CALL', 'error'); return; }
    if (!p) { M.toast('No phone number on file' + (leadName ? ' for ' + leadName : ''), 'warn'); return; }
    dial(leadName || (lead && lead.name) || (cust && cust.first + ' ' + cust.last) || '', p, lead, cust);
  };

  // ---- Phone widget (bottom-right) ----
  function ensurePhoneDom() {
    if ($('msihubPhone')) return;
    const st = document.createElement('style'); st.id = 'msihub-phone-styles';
    // Sits just left of the team-chat bubble (bottom-right corner).
    st.textContent = '#msihubPhone{position:fixed;right:88px;bottom:24px;z-index:20000;font-family:var(--font-body,"TT Hoves",sans-serif)}' +
      '.mph-pill{margin-bottom:11px;display:flex;align-items:center;gap:7px;background:#000;color:#fff;border:1px solid rgba(255,255,255,0.18);border-radius:999px;padding:6px 12px;font-size:11.5px;font-weight:500;cursor:pointer;font-family:inherit;opacity:.82}' +
      '.mph-pill:hover{opacity:1}.mph-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}' +
      '.mph-card{width:300px;background:#000;color:#fff;border-radius:16px;padding:16px;box-shadow:0 18px 44px rgba(0,0,0,0.38);border:1px solid rgba(255,255,255,0.14)}' +
      '.mph-status{font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.8px;color:#09C4CD}' +
      '.mph-name{font-size:17px;font-weight:500;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mph-num{font-size:12.5px;color:rgba(255,255,255,0.68);margin-top:2px}' +
      '.mph-actions{display:flex;gap:7px;margin-top:14px;flex-wrap:wrap}' +
      '.mph-btn{flex:1;min-width:58px;border:1px solid rgba(255,255,255,0.22);background:transparent;color:#fff;border-radius:9px;padding:8px 6px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit}' +
      '.mph-btn.on{background:#fff;color:#000}.mph-btn.go{background:#09C4CD;color:#000;border-color:#09C4CD}.mph-btn.end{background:var(--red,#EF4444);color:#fff;border-color:var(--red,#EF4444)}' +
      '.mph-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:12px}.mph-pad .mph-btn{padding:9px 0;font-size:15px}';
    document.head.appendChild(st);
    const el = document.createElement('div'); el.id = 'msihubPhone'; document.body.appendChild(el);
    const au = document.createElement('audio'); au.id = 'msihubPhoneAudio'; au.autoplay = true; document.body.appendChild(au);
  }
  function renderPhone() {
    ensurePhoneDom();
    const el = $('msihubPhone'); const c = P.call;
    if (P.tick) { clearInterval(P.tick); P.tick = null; }
    if (!c) {
      if (!voiceOn()) { el.innerHTML = ''; return; }
      const look = { ready: ['#09C4CD', 'Phone ready'], connecting: ['#D97706', 'Phone connecting…'], error: ['#DC2626', 'Phone offline — click to retry'] }[P.state] || ['#696969', 'Phone off'];
      el.innerHTML = '<button type="button" class="mph-pill" title="' + esc(P.error || look[1]) + '" onclick="MSIHub.telnyx.reconnect()"><span class="mph-dot" style="background:' + look[0] + '"></span>' + look[1] + '</button>';
      return;
    }
    const b = (label, fn, cls) => '<button type="button" class="mph-btn' + (cls ? ' ' + cls : '') + '" onclick="MSIHub.telnyx.' + fn + '">' + label + '</button>';
    const ringing = c.dir === 'inbound' && !c.accepted;
    el.innerHTML = '<div class="mph-card">' +
      '<div class="mph-status" id="mphStatus">' + esc(statusText(c)) + '</div>' +
      '<div class="mph-name">' + esc(c.name) + '</div><div class="mph-num">' + esc(c.phone) + '</div>' +
      (c.pad ? '<div class="mph-pad">' + ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((d) => b(d, "key('" + d + "')")).join('') + '</div>' : '') +
      '<div class="mph-actions">' + (ringing
        ? b('Answer', 'answer()', 'go') + b('Decline', 'hangup()', 'end')
        : b(c.muted ? 'Unmute' : 'Mute', 'mute()', c.muted ? 'on' : '') + (c.answeredAt ? b(c.held ? 'Resume' : 'Hold', 'hold()', c.held ? 'on' : '') : '') + b('Keypad', 'keypad()', c.pad ? 'on' : '') + b('Hang up', 'hangup()', 'end')) +
      '</div>' +
      (c.lead || c.cust ? '<div class="mph-actions" style="margin-top:7px">' + b('Open profile', 'openProfile()') + '</div>' : '') +
      '</div>';
    P.tick = setInterval(() => { const s = $('mphStatus'); if (s && P.call) s.textContent = statusText(P.call); }, 1000);
  }

  // ------------------------------------------------------------------
  // SETTINGS  (Admin > Call & Text Settings)
  // ------------------------------------------------------------------
  function telnyxPanel() {
    const c = cfg(), st = T.status, nums = (st && st.numbers) || [];
    const head = (t) => '<div style="font-size:10px;font-weight:500;color:var(--navy-700);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:12px;padding-bottom:6px;border-bottom:2px solid var(--navy-100)">' + t + '</div>';
    const line = (ok, label, help) => '<div style="display:flex;gap:8px;align-items:baseline;font-size:13px;margin-bottom:6px"><span style="font-weight:500;color:' + (ok ? '#067C83' : 'var(--red)') + '">' + (ok ? '✓' : '✗') + '</span><span>' + label + (ok ? '' : ' <span style="color:var(--gray-500)">— ' + help + '</span>') + '</span></div>';
    const numField = (id, value) => nums.length
      ? '<select class="form-control" id="' + id + '"><option value="">— None —</option>' + nums.map((n) => '<option value="' + esc(n.number) + '"' + (e164(value) === n.number ? ' selected' : '') + '>' + esc(H.fmtPhone(n.number)) + (n.texting ? '' : ' (calls only)') + '</option>').join('') + '</select>'
      : '<input class="form-control" id="' + id + '" placeholder="(619) 555-0100" value="' + esc(value ? H.fmtPhone(value) : '') + '">';
    const check = (id, on, label) => '<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:500;cursor:pointer"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '> ' + label + '</label>';

    let status;
    if (T.checking) status = '<div style="font-size:13px;color:var(--gray-500)">Checking…</div>';
    else if (T.statusError) status = '<div style="font-size:13px;color:var(--red)">' + esc(T.statusError) + '</div>';
    else if (!st) status = '<div style="font-size:13px;color:var(--gray-500)">Click “Check connection” to see whether Telnyx is linked and which numbers are available.</div>';
    else status =
      line(st.api_key && !st.error, 'Telnyx account linked', esc(st.error || 'the TELNYX_API_KEY secret is missing')) +
      line(st.public_key, 'Incoming texts and calls can be verified', 'the TELNYX_WEBHOOK_SECRET secret is missing') +
      line(st.connection_id, 'Browser calling is set up', 'the TELNYX_CONNECTION_ID secret is missing') +
      line(st.schema, 'Database is up to date', 'run supabase/schema-v4.sql in the Supabase SQL Editor') +
      line(nums.length > 0, nums.length + ' phone number' + (nums.length === 1 ? '' : 's') + ' on the account', 'buy or port a number in Telnyx') +
      '<div style="font-size:12px;color:var(--gray-500);margin-top:8px">Webhook address for Telnyx: <code style="user-select:all">' + esc(st.webhook_url || '') + '</code></div>';

    const agents = M.agents().filter((p) => 'telnyx_number' in p);
    return '<div class="card" style="margin-bottom:18px">' +
      '<div class="card-header"><div><div class="card-title">Phone System (Telnyx)</div><div style="font-size:13px;color:var(--gray-500);margin-top:2px">Real texting and calling from inside MaxSaveHub</div></div>' +
      '<button class="btn btn-ghost" style="font-size:13px" onclick="MSIHub.telnyx.check()">Check connection</button></div>' +
      '<div class="card-body">' +
      '<div style="margin-bottom:20px">' + status + '</div>' +
      head('Texting') +
      '<div class="form-grid" style="margin-bottom:20px">' +
        '<div class="form-group">' + check('tx_sms_on', c.sms_enabled, 'Send and receive real texts') + '<div style="font-size:12px;color:var(--gray-500);margin-top:6px">Off = texts are only logged, never sent.</div></div>' +
        '<div class="form-group"><div class="form-label">Agency text number</div>' + numField('tx_sms_number', c.sms_number) + '</div>' +
      '</div>' +
      head('Calling') +
      '<div class="form-grid" style="margin-bottom:20px">' +
        '<div class="form-group">' + check('tx_voice_on', c.voice_enabled, 'Make and take calls in the browser') + '<div style="font-size:12px;color:var(--gray-500);margin-top:6px">Off = the Call button opens this computer’s dialer and logs the call.</div></div>' +
        '<div class="form-group"><div class="form-label">Caller ID number</div>' + numField('tx_caller_id', c.caller_id) + '</div>' +
        '<div class="form-group"><div class="form-label">If nobody answers, forward to</div><input class="form-control" id="tx_fallback" placeholder="(619) 555-0100" value="' + esc(c.fallback_number ? H.fmtPhone(c.fallback_number) : '') + '"></div>' +
      '</div>' +
      (agents.length ? head('Direct numbers (optional)') +
        '<div style="font-size:12.5px;color:var(--gray-500);margin-bottom:10px">An agent with a direct number texts and calls from it; everyone else uses the agency numbers above.</div>' +
        '<div class="form-grid" style="margin-bottom:20px">' + agents.map((p) => '<div class="form-group"><div class="form-label">' + esc(p.full_name) + '</div>' + numField('tx_agent_' + p.id, p.telnyx_number) + '</div>').join('') + '</div>' : '') +
      '<button class="btn btn-primary" style="font-size:13px" onclick="MSIHub.telnyx.save()">Save Phone Settings</button>' +
      '</div></div>';
  }
  const _renderCallSettingsPanel = window.renderCallSettingsPanel;
  window.renderCallSettingsPanel = function () {
    let rest = '';
    try { rest = typeof _renderCallSettingsPanel === 'function' ? _renderCallSettingsPanel.apply(this, arguments) : ''; } catch (e) { console.warn('[MSIHub] call settings panel', e); }
    return telnyxPanel() + rest;
  };
  const repaintSettings = () => { if (window.CURRENT_PAGE === 'admin' && (window.ADMIN_STATE || {}).panel === 'callsettings' && typeof refreshAdminPage === 'function') refreshAdminPage(); };

  T.check = async function () {
    T.status = null; T.statusError = null; T.checking = true; repaintSettings();
    try { T.status = await call('status'); } catch (e) { T.statusError = e.message; }
    T.checking = false; repaintSettings();
  };

  T.save = async function () {
    if (!H.isAdmin()) { M.toast('Only an admin can change phone settings', 'warn'); return; }
    const val = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
    const on = (id) => { const el = $(id); return !!(el && el.checked); };
    const num = (id, label) => { const v = val(id); if (!v) return null; const n = e164(v); if (!n) throw new Error(label + ' is not a valid 10-digit phone number'); return n; };
    let next; const agentNums = [];
    try {
      next = Object.assign({}, cfg(), { sms_enabled: on('tx_sms_on'), voice_enabled: on('tx_voice_on'), sms_number: num('tx_sms_number', 'The text number'), caller_id: num('tx_caller_id', 'The caller ID number'), fallback_number: num('tx_fallback', 'The forwarding number') });
      if (next.sms_enabled && !next.sms_number) throw new Error('Pick an agency text number before turning texting on');
      if (next.voice_enabled && !next.caller_id) throw new Error('Pick a caller ID number before turning calling on');
      M.agents().forEach((p) => { if ($('tx_agent_' + p.id)) agentNums.push([p, num('tx_agent_' + p.id, p.full_name + '’s direct number')]); });
    } catch (e) { M.toast(e.message, 'warn'); return; }
    const { error } = await M.sb.from('agency_settings').upsert({ key: 'telnyx', value: next, updated_by: H.myId(), updated_at: new Date().toISOString() });
    if (error) { H.fail('Saving phone settings', error); return; }
    const i = M.data.agency_settings.findIndex((r) => r.key === 'telnyx');
    if (i >= 0) M.data.agency_settings[i] = { key: 'telnyx', value: next }; else M.data.agency_settings.push({ key: 'telnyx', value: next });
    for (const [p, n] of agentNums) {
      if ((p.telnyx_number || null) === n) continue;
      try { await H.update('profiles', p.id, { telnyx_number: n }); p.telnyx_number = n; } catch (e) { H.fail('Saving ' + p.full_name + '’s number', e); }
    }
    M.toast('Phone settings saved');
    syncPhone(true); repaintSettings();
  };

  // ------------------------------------------------------------------
  // Register: run after every data load / reload
  // ------------------------------------------------------------------
  let started = false;
  M.hooks.remap.push(function () {
    annotate(); refreshOpenThread();
    if (!M.user) return;
    if (!started) { started = true; subscribe(); setInterval(() => { syncPhone(); beat(); }, 40000); }
    syncPhone();
  });
})();
