/* =========================================================
   app-common.js — WebRTC DataChannel + chunking + sohbet UI
   ========================================================= */
(function (global) {
  'use strict';

  const CHUNK_SIZE = 16 * 1024;          // 16 KB
  const BUFFER_THRESHOLD = 1024 * 1024;  // 1 MB

  const state = {
    pc: null,
    dc: null,
    role: null,          // 'desktop' | 'mobile'
    connected: false,
    incoming: null,      // { meta, chunks: [], received }
    outgoingQueue: Promise.resolve()
  };

  const els = {};

  function $(id) { return document.getElementById(id); }

  function cacheEls() {
    els.status      = $('conn-status');
    els.matchScreen = $('match-screen');
    els.chat        = $('chat');
    els.messages    = $('messages');
    els.textInput   = $('text-input');
    els.sendBtn     = $('send-btn');
    els.fileInput   = $('file-input');
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  /* ---------------- WebRTC iskeleti ---------------- */

  function createPeer() {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.ondatachannel = (e) => bindDataChannel(e.channel);
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        setConnected(false);
      }
    };

    state.pc = pc;
    return pc;
  }

  function bindDataChannel(dc) {
    state.dc = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      setConnected(true);
    };
    dc.onclose = () => setConnected(false);
    dc.onerror  = (e) => console.error('DC error', e);

    dc.onmessage = (event) => handleIncoming(event.data);
  }

  function setConnected(v) {
    state.connected = v;
    if (els.status) {
      els.status.textContent = v ? 'Bağlı • Uçtan uca şifreli' : 'Bağlı değil';
      els.status.classList.toggle('connected', v);
    }
    if (v) {
      els.matchScreen?.classList.add('hidden');
      els.chat?.classList.add('visible');
      // Mobil tarafta kamera akışını kapat
      if (state.role === 'mobile') stopCamera();
    }
  }

  /* ---------------- SDP sıkıştırma (QR için) ---------------- */

  // Uzun SDP metnini base64 + LZ-string benzeri basit sıkıştırma yerine
  // önce JSON → deflate yok; textarea sığdırmak için kısa yol: base64 + URI encode
  // QR'ın kapasitesi ~2.9 KB; SDP genelde 1.5-2.5 KB. Gerekirse 'trickle: false'
  function encodeSDP(desc) {
    const obj = { type: desc.type, sdp: desc.sdp };
    const json = JSON.stringify(obj);
    return btoa(unescape(encodeURIComponent(json)));
  }

  function decodeSDP(b64) {
    const json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json);
  }

  function waitForIceGatheringComplete(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 4000);
    });
  }

  /* -------- Desktop: offer üret (QR için) -------- */
  async function createOffer() {
    createPeer();
    const dc = state.pc.createDataChannel('p2p', { ordered: true });
    bindDataChannel(dc);

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(state.pc);
    return encodeSDP(state.pc.localDescription);
  }

  /* -------- Mobile: offer'ı al, answer üret -------- */
  async function acceptOfferAndAnswer(b64Offer) {
    createPeer();
    const offer = decodeSDP(b64Offer);
    await state.pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(state.pc);
    return encodeSDP(state.pc.localDescription);
  }

  /* -------- Desktop: answer'ı uygula -------- */
  async function applyAnswer(b64Answer) {
    const answer = decodeSDP(b64Answer);
    await state.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  /* ---------------- Gönderim ---------------- */

  function sendText(text) {
    if (!state.dc || state.dc.readyState !== 'open') return;
    state.dc.send(JSON.stringify({ t: 'text', body: text }));
    appendTextBubble(text, 'me');
  }

  function sendFile(file) {
    if (!state.dc || state.dc.readyState !== 'open') return;

    const id = crypto.randomUUID();
    const meta = {
      t: 'file-meta',
      id,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream'
    };

    // Meta'yı gönder
    state.dc.send(JSON.stringify(meta));

    // UI: kendi tarafımızda ilerleme balonu
    const bubble = document.createElement('div');
    bubble.className = 'msg me';
    bubble.innerHTML = `<div><strong>${escapeHTML(file.name)}</strong> <span class="muted">gönderiliyor…</span></div>
      <div class="progress"><div></div></div>`;
    els.messages.appendChild(bubble);
    scrollBottom();
    const bar = bubble.querySelector('.progress > div');

    // Chunk gönder
    const reader = new FileReader();
    let offset = 0;

    const readSlice = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = async () => {
      const buf = reader.result;
      // Backpressure bekle
      while (state.dc.bufferedAmount > BUFFER_THRESHOLD) {
        await new Promise((r) => setTimeout(r, 30));
      }
      const arr = new Uint8Array(buf);
      // 1 byte tip + 36 byte UUID + veri
      const packet = new Uint8Array(1 + 36 + arr.length);
      packet[0] = 1; // chunk tipi
      packet.set(new TextEncoder().encode(id), 1);
      packet.set(arr, 37);
      state.dc.send(packet.buffer);

      offset += buf.byteLength;
      const pct = Math.min(100, (offset / file.size) * 100);
      bar.style.width = pct.toFixed(1) + '%';
      if (offset < file.size) {
        readSlice();
      } else {
        state.dc.send(JSON.stringify({ t: 'file-end', id }));
        bar.parentElement.querySelector('.muted').textContent = 'gönderildi ✓';
      }
    };

    readSlice();
  }

  /* ---------------- Alım ---------------- */

  function handleIncoming(data) {
    // Metin/JSON
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      switch (msg.t) {
        case 'text':
          appendTextBubble(msg.body, 'them');
          break;
        case 'file-meta':
          state.incoming = {
            meta: msg,
            chunks: [],
            received: 0
          };
          showIncomingProgressBubble(msg);
          break;
        case 'file-end':
          finalizeIncomingFile(msg.id);
          break;
      }
      return;
    }

    // Binary chunk
    const view = new Uint8Array(data);
    if (view[0] !== 1 || !state.incoming) return;
    const id = new TextDecoder().decode(view.slice(1, 37));
    if (id !== state.incoming.meta.id) return;
    const payload = view.slice(37);
    state.incoming.chunks.push(payload);
    state.incoming.received += payload.length;

    const meta = state.incoming.meta;
    const pct = Math.min(100, (state.incoming.received / meta.size) * 100);
    updateIncomingProgress(meta.id, pct);
  }

  function showIncomingProgressBubble(meta) {
    const bubble = document.createElement('div');
    bubble.className = 'msg them';
    bubble.dataset.id = meta.id;
    bubble.innerHTML = `<div><strong>${escapeHTML(meta.name)}</strong>
      <span class="muted">alınıyor… (${formatSize(meta.size)})</span></div>
      <div class="progress"><div></div></div>`;
    els.messages.appendChild(bubble);
    scrollBottom();
  }

  function updateIncomingProgress(id, pct) {
    const bubble = els.messages.querySelector(`.msg[data-id="${id}"]`);
    if (!bubble) return;
    const bar = bubble.querySelector('.progress > div');
    if (bar) bar.style.width = pct.toFixed(1) + '%';
  }

  function finalizeIncomingFile(id) {
    const inc = state.incoming;
    if (!inc || inc.meta.id !== id) return;

    const blob = new Blob(inc.chunks, { type: inc.meta.mime });
    const url = URL.createObjectURL(blob);
    const bubble = els.messages.querySelector(`.msg[data-id="${id}"]`);
    if (bubble) {
      bubble.innerHTML = '';
      const title = document.createElement('div');
      title.innerHTML = `<strong>${escapeHTML(inc.meta.name)}</strong>
        <span class="muted">(${formatSize(inc.meta.size)})</span>`;
      bubble.appendChild(title);

      if (inc.meta.mime.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = inc.meta.name;
        bubble.appendChild(img);
      } else if (inc.meta.mime.startsWith('video/')) {
        const vid = document.createElement('video');
        vid.src = url;
        vid.controls = true;
        bubble.appendChild(vid);
      } else if (inc.meta.mime.startsWith('audio/')) {
        const aud = document.createElement('audio');
        aud.src = url;
        aud.controls = true;
        bubble.appendChild(aud);
      }

      const a = document.createElement('a');
      a.href = url;
      a.download = inc.meta.name;
      a.className = 'download';
      a.textContent = '⬇ İndir';
      bubble.appendChild(a);
    }
    state.incoming = null;
    scrollBottom();
  }

  /* ---------------- Yardımcılar ---------------- */

  function appendTextBubble(text, who) {
    const d = document.createElement('div');
    d.className = 'msg ' + who;
    d.textContent = text;
    els.messages.appendChild(d);
    scrollBottom();
  }

  function scrollBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  /* ---------------- Kamera ---------------- */

  let cameraStream = null;

  async function startCamera(videoEl) {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false
      });
      videoEl.srcObject = cameraStream;
      await videoEl.play();
      return cameraStream;
    } catch (e) {
      toast('Kamera erişimi reddedildi: ' + e.message);
      throw e;
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
  }

  /* ---------------- Public API ---------------- */

  global.P2P = {
    state,
    cacheEls,
    toast,
    createOffer,
    acceptOfferAndAnswer,
    applyAnswer,
    sendText,
    sendFile,
    setConnected,
    setRole: (r) => { state.role = r; },
    startCamera,
    stopCamera,
    formatSize
  };

  // UI olaylarını bağla
  document.addEventListener('DOMContentLoaded', () => {
    cacheEls();
    if (els.sendBtn && els.textInput) {
      els.sendBtn.addEventListener('click', () => {
        const t = els.textInput.value.trim();
        if (!t) return;
        sendText(t);
        els.textInput.value = '';
      });
      els.textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') els.sendBtn.click();
      });
    }
    if (els.fileInput) {
      els.fileInput.addEventListener('change', (e) => {
        const f = e.target.files?.[0];
        if (f) sendFile(f);
        e.target.value = '';
      });
    }
  });
})(window);