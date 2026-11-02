/* ==========================================================
   mobile.js — QR oku → answer üret → cevap QR göster →
   bilgisayar cevabı uygulayınca bağlantı kurulur
   ========================================================== */
(function () {
  'use strict';

  const { P2P } = window;
  const els = {};

  document.addEventListener('DOMContentLoaded', async () => {
    P2P.setRole('mobile');
    els.scanVideo   = document.getElementById('scan-video');
    els.matchScreen = document.getElementById('match-screen');
    els.answerScreen= document.getElementById('answer-screen');
    els.answerQR    = document.getElementById('answer-qr');

    try {
      await P2P.startCamera(els.scanVideo);
    } catch (e) {
      return;
    }
    startScanLoop();
  });

  function startScanLoop() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const scan = () => {
      const v = els.scanVideo;
      if (v.readyState === v.HAVE_ENOUGH_DATA && window.jsQR) {
        canvas.width  = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(imgData.data, canvas.width, canvas.height, {
          inversionAttempts: 'dontInvert'
        });
        if (code && code.data) {